import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
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
  getOrCreateDiscussion,
  checkoutTaskBranch,
  getModels,
  type Workspace,
  type ModelInfo,
  type Task,
  type TaskCounts,
  type TokenTotals,
  type ClaudeUsage,
} from '../api/client';
import { playChime } from '../utils/chime';
import { useDraft, useSessionState } from '../hooks/useDraft';
import TaskDetailModal from '../components/TaskDetailModal';
import DiscussionModal from '../components/DiscussionModal';

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

export default function WorkspacesPage({ selfWorkspaceId }: { selfWorkspaceId?: string | null }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, TaskCounts>>({});
  const [tokenTotals, setTokenTotals] = useState<Record<string, TokenTotals>>({});
  const [githubRepoUrls, setGithubRepoUrls] = useState<Record<string, string>>({});
  const [latestDiscussionMessages, setLatestDiscussionMessages] = useState<Record<string, string>>({});
  const [claudeUsage, setClaudeUsage] = useState<Record<string, ClaudeUsage>>({});
  const [tasksByWorkspace, setTasksByWorkspace] = useState<Record<string, Task[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showStopped, setShowStopped] = useState(false);
  const [deletedTaskId, setDeletedTaskId] = useState<string | null>(null);
  const [newTaskWorkspaceId, setNewTaskWorkspaceId] = useSessionState<string | null>('newTaskWorkspaceId', null);
  const [newTaskPrompt, setNewTaskPrompt, clearNewTaskPrompt] = useDraft('newTaskPrompt');
  const [newTaskBranch, setNewTaskBranch] = useState('');
  const [newTaskModel, setNewTaskModel] = useState('');
  const [newTaskCaveman, setNewTaskCaveman] = useState('');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useSessionState<string | null>('selectedTaskId', null);
  const [discussionState, setDiscussionState] = useState<{ id: string; workspaceId: string; workspaceName: string } | null>(null);
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

  const loadData = async () => {
    try {
      const { workspaces: ws, taskCounts: tc, tokenTotals: tt, githubRepoUrls: gh, latestDiscussionMessages: ldm, claudeUsage: cu } = await getWorkspaces();
      setIfChanged('workspaces', setWorkspaces, ws);
      setIfChanged('taskCounts', setTaskCounts, tc);
      setIfChanged('tokenTotals', setTokenTotals, tt || {});
      setIfChanged('githubRepoUrls', setGithubRepoUrls, gh || {});
      setIfChanged('latestDiscussionMessages', setLatestDiscussionMessages, ldm || {});
      setIfChanged('claudeUsage', setClaudeUsage, cu || {});
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
    .filter((ws) => ws.latest_build.status === 'running' && ws.id !== selfWorkspaceId)
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
    workspaces.filter((ws) => ws.latest_build.status !== 'running' && ws.id !== selfWorkspaceId),
    [workspaces, selfWorkspaceId]
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
  const headerDeps = runningWorkspaces.map(ws => ws.id).join(',') + '|' + Object.keys(claudeUsage).join(',');
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
      setNewTaskBranch('');
    };
    window.addEventListener('keydown', handleAltN);
    return () => window.removeEventListener('keydown', handleAltN);
  }, []);

  // Fetch available models when task creation form opens for a workspace
  useEffect(() => {
    if (!newTaskWorkspaceId) {
      setAvailableModels([]);
      setNewTaskModel('');
      return;
    }
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

  const [checkingOutTaskId, setCheckingOutTaskId] = useState<string | null>(null);
  const handleCheckoutBranch = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCheckingOutTaskId(taskId);
    try {
      await checkoutTaskBranch(taskId);
    } catch (err: any) {
      alert(err.message || 'Failed to checkout branch');
    } finally {
      setCheckingOutTaskId(null);
    }
  };

  const handleUndo = async () => {
    if (!deletedTaskId) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    await restoreTask(deletedTaskId);
    setDeletedTaskId(null);
    await loadData();
  };

  const markChatSeen = (workspaceId: string) => {
    try {
      const seen = JSON.parse(localStorage.getItem('chatLastSeen') || '{}');
      seen[workspaceId] = new Date().toISOString();
      localStorage.setItem('chatLastSeen', JSON.stringify(seen));
    } catch { /* ignore */ }
  };

  const getChatLastSeen = (workspaceId: string): string | null => {
    try {
      const seen = JSON.parse(localStorage.getItem('chatLastSeen') || '{}');
      return seen[workspaceId] || null;
    } catch { return null; }
  };

  const hasUnreadChat = (workspaceId: string): boolean => {
    const latest = latestDiscussionMessages[workspaceId];
    if (!latest) return false;
    const lastSeen = getChatLastSeen(workspaceId);
    if (!lastSeen) return true; // never opened → unread if any messages exist
    return latest > lastSeen;
  };

  const handleOpenDiscussion = async (workspaceId: string, workspaceName: string) => {
    try {
      const { discussion } = await getOrCreateDiscussion(workspaceId);
      markChatSeen(workspaceId);
      setDiscussionState({ id: discussion.id, workspaceId, workspaceName });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to open discussion');
    }
  };

  const handleCreateTask = async (workspaceId: string) => {
    if (!newTaskPrompt.trim()) return;
    setCreatingTask(true);
    try {
      const branch = newTaskBranch.trim() || undefined;
      const model = newTaskModel || undefined;
      const caveman = newTaskCaveman || undefined;
      await createTask(workspaceId, newTaskPrompt.trim(), branch, model, caveman);
      lastTaskWorkspaceIdRef.current = workspaceId;
      clearNewTaskPrompt();
      setNewTaskBranch('');
      setNewTaskModel('');
      setNewTaskCaveman('');
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
      <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 mt-1">
        <span>{new Date(task.created_at).toLocaleString()}</span>
        {task.model && (
          <span className={`px-1.5 py-0.5 rounded font-medium ${
            task.model.startsWith('ollama/')
              ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
              : 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
          }`}>
            {task.model.startsWith('ollama/')
              ? task.model.slice('ollama/'.length).replace(/:latest$/, '')
              : task.model.replace(/^claude-/, '')}
          </span>
        )}
      </div>
      {task.git_branch && (
        <div className="mt-1 flex items-center gap-1">
          {task.github_repo_url ? (
            <a
              href={`${task.github_repo_url}/tree/${task.git_branch}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors font-mono"
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M11.75 2.5a.75.75 0 0 1 0 1.5h-.75v4h.75a.75.75 0 0 1 0 1.5h-.75v.75a4.25 4.25 0 0 1-8.5 0V9.5H2a.75.75 0 0 1 0-1.5h.75V4H2a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5H4.25v4h1.5V4H4.5a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5H7.25v4h1.5v-4H8a.75.75 0 0 1 0-1.5ZM9.5 9.5h-4v.75a2.75 2.75 0 1 0 5.5 0V9.5h-.75Z" /></svg>
              {task.git_branch}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-mono">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M11.75 2.5a.75.75 0 0 1 0 1.5h-.75v4h.75a.75.75 0 0 1 0 1.5h-.75v.75a4.25 4.25 0 0 1-8.5 0V9.5H2a.75.75 0 0 1 0-1.5h.75V4H2a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5H4.25v4h1.5V4H4.5a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5H7.25v4h1.5v-4H8a.75.75 0 0 1 0-1.5ZM9.5 9.5h-4v.75a2.75 2.75 0 1 0 5.5 0V9.5h-.75Z" /></svg>
              {task.git_branch}
            </span>
          )}
          {task.status !== 'working' && (
            <button
              onClick={(e) => handleCheckoutBranch(e, task.id)}
              disabled={checkingOutTaskId === task.id}
              className="inline-flex items-center justify-center w-5 h-5 rounded text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors disabled:opacity-50"
              title="Switch workspace to this branch"
            >
              {checkingOutTaskId === task.id ? (
                <div className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
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
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {task.caveman && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium" title={`Caveman mode: ${task.caveman}`}>
              {task.caveman === 'ultra' ? '🦴 ultra' : task.caveman === 'full' ? '🦴 full' : '🦴 lite'}
            </span>
          )}
          {(task.total_input_tokens > 0 || task.total_output_tokens > 0) && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono" title={`In: ${task.total_input_tokens.toLocaleString()} | Out: ${task.total_output_tokens.toLocaleString()}`}>
              {formatTokens(task.total_input_tokens + task.total_output_tokens)}t
            </span>
          )}
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
    const githubRepoUrl = githubRepoUrls[ws.id] || tasks.find(t => t.github_repo_url)?.github_repo_url || null;

    return (
      <div
        key={ws.id}
        data-ws-id={ws.id}
        className={`flex-shrink-0 w-80 flex flex-col rounded-lg border ${
          isRunning
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
              {claudeUsage[ws.name] && (
                <div className="mt-1" title={`Claude ${claudeUsage[ws.name].rateLimitType.replace(/_/g, ' ')} usage: ${Math.round(claudeUsage[ws.name].utilization * 100)}%`}>
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          claudeUsage[ws.name].utilization >= 0.9
                            ? 'bg-red-500'
                            : claudeUsage[ws.name].utilization >= 0.75
                              ? 'bg-amber-500'
                              : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.round(claudeUsage[ws.name].utilization * 100))}%` }}
                      />
                    </div>
                    <span className={`text-[10px] font-mono ${
                      claudeUsage[ws.name].utilization >= 0.9
                        ? 'text-red-500'
                        : claudeUsage[ws.name].utilization >= 0.75
                          ? 'text-amber-500'
                          : 'text-gray-400 dark:text-gray-500'
                    }`}>
                      {Math.round(claudeUsage[ws.name].utilization * 100)}%
                    </span>
                  </div>
                </div>
              )}
            </div>
            {isRunning && (
              <div className="flex gap-1.5 shrink-0 mt-0.5">
                <button
                  onClick={() => handleOpenDiscussion(ws.id, ws.name)}
                  className="relative text-xs px-2 py-0.5 bg-purple-600 text-white rounded-full hover:bg-purple-700 transition-colors"
                  title="Open discussion"
                >
                  Chat
                  {hasUnreadChat(ws.id) && !discussionState && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full border border-white dark:border-gray-900" />
                  )}
                </button>
                <button
                  onClick={() => { setNewTaskWorkspaceId(ws.id); clearNewTaskPrompt(); setNewTaskBranch(''); }}
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
                    setNewTaskBranch('');
                  }
                }}
                placeholder="What should Claude do?"
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={2}
                disabled={creatingTask}
              />
              <input
                type="text"
                value={newTaskBranch}
                onChange={(e) => setNewTaskBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    handleCreateTask(ws.id);
                  }
                  if (e.key === 'Escape') {
                    setNewTaskWorkspaceId(null);
                    clearNewTaskPrompt();
                    setNewTaskBranch('');
                  }
                }}
                placeholder="Branch name (optional)"
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-1.5 mt-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
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
              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => handleCreateTask(ws.id)}
                  disabled={creatingTask || !newTaskPrompt.trim()}
                  className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {creatingTask ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => { setNewTaskWorkspaceId(null); clearNewTaskPrompt(); setNewTaskBranch(''); }}
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
        <div ref={laneContainerRef} className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0">
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

      {discussionState && (
        <DiscussionModal
          discussionId={discussionState.id}
          workspaceId={discussionState.workspaceId}
          workspaceName={discussionState.workspaceName}
          onClose={() => { markChatSeen(discussionState.workspaceId); setDiscussionState(null); }}
          onTaskCreated={loadData}
        />
      )}
    </div>
  );
}
