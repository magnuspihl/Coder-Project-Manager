import { useState, useEffect, useRef, type FormEvent } from 'react';
import {
  getTaskDetail,
  getStreamLog,
  replyToTask,
  completeTask,
  reopenTask,
  retryTask,
  interruptTask,
  cancelTask,
  deleteTask,
  checkoutTaskBranch,
  addTaskParticipant,
  removeTaskParticipant,
  sendTaskParticipantMessage,
  getWorkspaces,
  type Task,
  type Message,
  type StreamLogEntry,
  type TaskParticipant,
  type Workspace,
} from '../api/client';
import { playChime } from '../utils/chime';
import RateLimitBanner from './RateLimitBanner';
import { useDraft } from '../hooks/useDraft';
import { linkify } from '../utils/linkify';
import Markdown from './Markdown';

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

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  working: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  awaiting_feedback: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
  completed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  cancelled: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
};

interface TaskDetailModalProps {
  taskId: string;
  onClose: () => void;
  onTaskChanged?: () => void;
}

export default function TaskDetailModal({ taskId, onClose, onTaskChanged }: TaskDetailModalProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamLog, setStreamLog] = useState<StreamLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reply, setReply, clearReply] = useDraft(`reply:${taskId}`);
  const [sending, setSending] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [participants, setParticipants] = useState<TaskParticipant[]>([]);
  const [targetParticipantId, setTargetParticipantId] = useState<string | null>(null);
  const [showInviteMenu, setShowInviteMenu] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const lastParticipantsJsonRef = useRef('');
  const prevStatusRef = useRef<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const maxStreamLogIdRef = useRef(0);

  const lastTaskJsonRef = useRef('');
  const lastMessagesJsonRef = useRef('');

  const loadData = async () => {
    try {
      const { task: newTask, messages: newMessages, participants: newParticipants } = await getTaskDetail(taskId);
      if (prevStatusRef.current && prevStatusRef.current !== 'awaiting_feedback' && newTask.status === 'awaiting_feedback') {
        playChime();
      }
      prevStatusRef.current = newTask.status;
      taskStatusRef.current = newTask.status;
      const taskJson = JSON.stringify(newTask);
      if (taskJson !== lastTaskJsonRef.current) {
        lastTaskJsonRef.current = taskJson;
        setTask(newTask);
      }
      const msgsJson = JSON.stringify(newMessages);
      if (msgsJson !== lastMessagesJsonRef.current) {
        lastMessagesJsonRef.current = msgsJson;
        setMessages(newMessages);
      }
      const pJson = JSON.stringify(newParticipants || []);
      if (pJson !== lastParticipantsJsonRef.current) {
        lastParticipantsJsonRef.current = pJson;
        setParticipants(newParticipants || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  // Load stream log only when panel is open, using incremental fetching
  const logOpenRef = useRef(logOpen);
  logOpenRef.current = logOpen;
  const taskStatusRef = useRef(task?.status);
  taskStatusRef.current = task?.status;
  const participantsRef = useRef(participants);
  participantsRef.current = participants;

  const loadStreamLog = async () => {
    try {
      const afterId = maxStreamLogIdRef.current;
      const { streamLog: newEntries } = await getStreamLog(taskId, afterId || undefined);
      if (newEntries.length > 0) {
        if (afterId === 0) {
          setStreamLog(newEntries.slice(-500));
        } else {
          setStreamLog(prev => {
            const combined = [...prev, ...newEntries];
            return combined.length > 500 ? combined.slice(-500) : combined;
          });
        }
        const lastEntry = newEntries[newEntries.length - 1];
        if (lastEntry?.id) maxStreamLogIdRef.current = lastEntry.id;
      }
    } catch {
      // ignore
    }
  };

  // Single unified poll: fetch task detail, and stream log when needed
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      await loadData();
      const isWorking = taskStatusRef.current === 'working';
      if (logOpenRef.current || isWorking) await loadStreamLog();
    };

    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      poll().finally(() => {
        if (cancelled) return;
        const anyPRunning = participantsRef.current.some(p => p.running);
        const pollMs = (taskStatusRef.current === 'working' || anyPRunning) ? 3000 : 10000;
        timer = setTimeout(tick, pollMs);
      });
    };
    tick(); // Initial load + start chain
    return () => { cancelled = true; clearTimeout(timer); };
  }, [taskId]);

  // Scroll to bottom on initial load and when new messages arrive
  useEffect(() => {
    if (!loading && scrollBodyRef.current) {
      const el = scrollBodyRef.current;
      if (!initialScrollDone.current) {
        // Instant scroll on first load
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
        initialScrollDone.current = true;
      } else {
        // Smooth scroll for subsequent updates, only if already near bottom
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        if (isNearBottom) {
          requestAnimationFrame(() => {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          });
        }
      }
    }
  }, [loading, messages.length, streamLog.length]);

  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamLog.length, logOpen]);

  // Push a history entry so the browser back button closes the modal
  useEffect(() => {
    window.history.pushState({ modal: 'task-detail' }, '');
    const handlePopState = () => {
      onClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  // When closing via non-back-button means (Escape, X, etc.), pop the history entry we pushed
  const closeModal = () => {
    // Only go back if we're still on the state we pushed
    if (window.history.state?.modal === 'task-detail') {
      window.history.back();
    } else {
      onClose();
    }
  };

  // Keyboard shortcuts: Escape to close, Alt+C to mark complete
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
      if (e.altKey && e.key === 'c' && taskStatusRef.current === 'awaiting_feedback') {
        e.preventDefault();
        handleComplete();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const closeAndNotify = () => {
    onTaskChanged?.();
    closeModal();
  };

  const handleReply = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    try {
      await replyToTask(taskId, reply.trim());
      clearReply();
      closeAndNotify();
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  const handleReplyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleReply();
    }
  };

  const handleComplete = async () => {
    try {
      await completeTask(taskId);
      closeAndNotify();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('uncommitted')) {
        alert(err.message);
      } else {
        closeAndNotify();
      }
    }
  };

  const handleRetry = async () => {
    await retryTask(taskId);
    closeAndNotify();
  };

  const handleReopen = async () => {
    await reopenTask(taskId);
    closeAndNotify();
  };

  const handleCheckout = async () => {
    if (!task?.git_branch) return;
    setCheckingOut(true);
    try {
      await checkoutTaskBranch(taskId);
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to switch branch');
    } finally {
      setCheckingOut(false);
    }
  };

  const handleInterrupt = async () => {
    await interruptTask(taskId);
    if (onTaskChanged) onTaskChanged();
    await loadData();
  };

  const handleCancel = async () => {
    await cancelTask(taskId);
    closeAndNotify();
  };

  const handleDelete = async () => {
    if (!confirm('Delete this task?')) return;
    await deleteTask(taskId);
    closeAndNotify();
  };

  // Participant handlers
  const handleOpenInviteMenu = async () => {
    setShowInviteMenu(true);
    if (availableWorkspaces.length === 0) {
      setLoadingWorkspaces(true);
      try {
        const { workspaces } = await getWorkspaces();
        const hostWsId = task?.workspace_id;
        const participantWsIds = new Set(participants.map(p => p.workspace_id));
        setAvailableWorkspaces(workspaces.filter(ws =>
          ws.id !== hostWsId && !participantWsIds.has(ws.id) &&
          ws.latest_build?.status === 'running'
        ));
      } catch { /* ignore */ }
      setLoadingWorkspaces(false);
    }
  };

  const handleInvite = async (ws: Workspace) => {
    setShowInviteMenu(false);
    try {
      await addTaskParticipant(taskId, ws.id, ws.name);
      setAvailableWorkspaces(prev => prev.filter(w => w.id !== ws.id));
      await loadData();
    } catch { /* ignore */ }
  };

  const handleRemoveParticipant = async (participantId: string) => {
    try {
      await removeTaskParticipant(taskId, participantId);
      if (targetParticipantId === participantId) setTargetParticipantId(null);
      await loadData();
    } catch { /* ignore */ }
  };

  const handleSendToParticipant = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!reply.trim() || !targetParticipantId) return;
    setSending(true);
    try {
      await sendTaskParticipantMessage(taskId, targetParticipantId, reply.trim());
      clearReply();
      await loadData();
    } catch (err) {
      if (err instanceof Error && err.message.includes('currently processing')) {
        // Don't clear, let user retry
      }
    } finally {
      setSending(false);
    }
  };

  const anyParticipantRunning = participants.some(p => p.running);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) closeModal();
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
    >
      <div className="bg-white dark:bg-gray-950 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-3xl max-h-[90vh] flex flex-col">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading task...</div>
        ) : !task ? (
          <div className="p-8 text-center text-red-600 dark:text-red-400">Task not found</div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-200 dark:border-gray-800">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">{task.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[task.status] || ''}`}>
                    {task.status.replace('_', ' ')}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">{task.workspace_name}</span>
                  {task.model && (
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      task.model.startsWith('ollama/')
                        ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                        : 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
                    }`}>
                      {task.model.startsWith('ollama/')
                        ? task.model.slice('ollama/'.length).replace(/:latest$/, '')
                        : task.model.replace(/^claude-/, '')}
                    </span>
                  )}
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(task.id);
                      setIdCopied(true);
                      setTimeout(() => setIdCopied(false), 1500);
                    }}
                    title={task.id}
                    className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 font-mono transition-colors"
                  >
                    {idCopied ? 'Copied!' : 'ID'}
                  </button>
                  {task.caveman && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium">
                      🦴 {task.caveman}
                    </span>
                  )}
                  {(task.total_input_tokens > 0 || task.total_output_tokens > 0) && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono"
                      title={`Input: ${task.total_input_tokens.toLocaleString()} | Output: ${task.total_output_tokens.toLocaleString()}`}
                    >
                      {formatTokens(task.total_input_tokens + task.total_output_tokens)} tokens
                    </span>
                  )}
                  {typeof task.total_cost_usd === 'number' && task.total_cost_usd > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono">
                      ${task.total_cost_usd.toFixed(2)}
                    </span>
                  )}
                  {task.git_branch && (
                    <span className="inline-flex items-center gap-0">
                      {task.github_repo_url ? (
                        <a
                          href={`${task.github_repo_url}/tree/${task.git_branch}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-l bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors font-mono"
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path fillRule="evenodd" d="M11.75 2.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-8.5 0a.75.75 0 0 1 .75.75v3.402c.458-.204.96-.319 1.489-.319A4.265 4.265 0 0 1 9.49 9.39V3.25a.75.75 0 0 1 1.5 0v7.5a.75.75 0 0 1-1.5 0v-.156a2.765 2.765 0 0 0-3.999-2.473A2.766 2.766 0 0 0 4 10.75v.001a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.751Z" clipRule="evenodd" /></svg>
                          {task.git_branch}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-l bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono">
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path fillRule="evenodd" d="M11.75 2.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-8.5 0a.75.75 0 0 1 .75.75v3.402c.458-.204.96-.319 1.489-.319A4.265 4.265 0 0 1 9.49 9.39V3.25a.75.75 0 0 1 1.5 0v7.5a.75.75 0 0 1-1.5 0v-.156a2.765 2.765 0 0 0-3.999-2.473A2.766 2.766 0 0 0 4 10.75v.001a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.751Z" clipRule="evenodd" /></svg>
                          {task.git_branch}
                        </span>
                      )}
                      {task.status !== 'working' && (
                        <button
                          onClick={handleCheckout}
                          disabled={checkingOut}
                          className="text-xs px-1.5 py-0.5 rounded-r bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors border-l border-gray-200 dark:border-gray-700 disabled:opacity-50"
                          title="Switch workspace to this branch"
                        >
                          {checkingOut ? (
                            <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                          )}
                        </button>
                      )}
                    </span>
                  )}
                  {task.verification_url && (
                    <a
                      href={task.verification_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                        <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                      </svg>
                      View Live
                    </a>
                  )}
                </div>
              </div>
              <button
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1"
                title="Close"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

            {/* Scrollable body */}
            <div ref={scrollBodyRef} className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Conversation */}
              {messages.map((msg) => {
                const isParticipantMsg = msg.role === 'assistant' && msg.participant_id;
                const participantName = msg.participant_id
                  ? participants.find(p => p.id === msg.participant_id)?.workspace_name
                  : null;
                // For user messages targeted at a participant, show the recipient
                const recipientLabel = msg.role === 'user' && msg.participant_id && participants.length > 0
                  ? participants.find(p => p.id === msg.participant_id)?.workspace_name
                  : null;

                return (
                  <div
                    key={msg.id}
                    className={`rounded-lg p-4 ${
                      msg.role === 'user'
                        ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 ml-8'
                        : msg.role === 'assistant' && isParticipantMsg
                        ? 'bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800 mr-8'
                        : msg.role === 'assistant'
                        ? 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 mr-8'
                        : msg.content.startsWith('Error:')
                        ? 'bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-700 dark:text-red-400 text-sm'
                        : 'bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-sm'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-medium uppercase ${isParticipantMsg ? 'text-teal-600 dark:text-teal-400' : 'text-gray-500 dark:text-gray-400'}`}>
                        {msg.role === 'user' && msg.username ? msg.username : (isParticipantMsg && participantName) ? participantName : msg.role}
                        {recipientLabel && (
                          <span className="ml-1 normal-case font-normal opacity-70">→ {recipientLabel}</span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {msg.cost && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">${msg.cost.toFixed(4)}</span>
                        )}
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {new Date(msg.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                    <Markdown content={msg.content} />
                  </div>
                );
              })}

              {task.status === 'working' && (() => {
                // Extract assistant text from stream log to show as a live message
                const liveText = streamLog
                  .filter(e => e.type === 'assistant')
                  .map(e => e.summary)
                  .join('\n\n');

                return (
                  <>
                    {liveText && (
                      <div className="rounded-lg p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 mr-8 opacity-80">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">assistant</span>
                          <span className="text-xs text-blue-500 dark:text-blue-400 italic">streaming...</span>
                        </div>
                        <Markdown content={liveText} />
                      </div>
                    )}
                    <div className="text-sm text-blue-600 dark:text-blue-400 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-100 dark:border-blue-800">
                      <div className="flex items-center gap-2">
                        <div className="animate-spin h-4 w-4 border-2 border-blue-600 dark:border-blue-400 border-t-transparent rounded-full" />
                        <span>Claude is working...</span>
                        {task.activity && (
                          <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                            Last activity {timeAgo(task.activity.timestamp)}
                          </span>
                        )}
                      </div>
                      {task.activity && (
                        <p className="mt-1 text-xs text-blue-500 dark:text-blue-300 truncate ml-6">
                          {linkify(task.activity.summary)}
                        </p>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* Participant thinking indicator */}
              {participants.filter(p => p.running).map(p => (
                <div key={`running-${p.id}`} className="text-sm text-teal-600 dark:text-teal-400 p-4 bg-teal-50 dark:bg-teal-900/20 rounded-lg border border-teal-100 dark:border-teal-800">
                  <div className="flex items-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-teal-600 dark:border-teal-400 border-t-transparent rounded-full" />
                    <span>{p.workspace_name} is thinking...</span>
                    {p.activity && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                        Last activity {timeAgo(p.activity.timestamp)}
                      </span>
                    )}
                  </div>
                  {p.activity && (
                    <p className="mt-1 text-xs text-teal-500 dark:text-teal-300 truncate ml-6">
                      {linkify(p.activity.summary)}
                    </p>
                  )}
                </div>
              ))}

              {/* Stream Log */}
              {streamLog.length > 0 && (
                <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setLogOpen(!logOpen)}
                    className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-900 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <span className="flex items-center gap-2">
                      <span className={`transition-transform ${logOpen ? 'rotate-90' : ''}`}>&#9654;</span>
                      Claude Output Log ({streamLog.length} entries)
                    </span>
                    {task.status === 'working' && (
                      <span className="text-xs text-blue-500 dark:text-blue-400">live</span>
                    )}
                  </button>
                  {logOpen && (
                    <div className="max-h-96 overflow-y-auto bg-gray-950 text-gray-300 p-3 font-mono text-xs leading-relaxed">
                      {streamLog.map((entry, i) => (
                        <div key={i} className="flex gap-2 py-0.5">
                          <span className="text-gray-600 shrink-0">
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </span>
                          <span className={`shrink-0 w-20 text-right ${
                            entry.type === 'tool_use' ? 'text-yellow-500' :
                            entry.type === 'assistant' ? 'text-green-400' :
                            entry.type === 'tool_result' ? 'text-gray-500' :
                            entry.type === 'result' ? 'text-blue-400' :
                            'text-gray-500'
                          }`}>
                            {entry.type}
                          </span>
                          <span className="break-all whitespace-pre-wrap">{linkify(entry.summary)}</span>
                        </div>
                      ))}
                      <div ref={logEndRef} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Actions footer */}
            <div className="border-t border-gray-200 dark:border-gray-800 p-5">
              {task.status === 'awaiting_feedback' && (
                <div className="space-y-3">
                  {/* Participant target selector */}
                  {participants.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => setTargetParticipantId(null)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                          !targetParticipantId
                            ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-medium'
                            : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-300 dark:hover:border-blue-700'
                        }`}
                      >
                        Task Agent
                      </button>
                      {participants.map(p => (
                        <div key={p.id} className="flex items-center gap-0">
                          <button
                            onClick={() => setTargetParticipantId(p.id)}
                            className={`text-xs px-2.5 py-1 rounded-l-full border transition-colors ${
                              targetParticipantId === p.id
                                ? 'bg-teal-100 dark:bg-teal-900/40 border-teal-300 dark:border-teal-700 text-teal-700 dark:text-teal-300 font-medium'
                                : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-teal-300 dark:hover:border-teal-700'
                            }`}
                          >
                            {p.workspace_name}
                            {p.running && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-teal-500 animate-pulse" />}
                          </button>
                          <button
                            onClick={() => handleRemoveParticipant(p.id)}
                            className="text-xs px-1.5 py-1 rounded-r-full border border-l-0 border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-500 hover:border-red-300 dark:hover:border-red-700 transition-colors"
                            title={`Remove ${p.workspace_name}`}
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                      {/* Invite button in selector bar */}
                      <div className="relative">
                        <button
                          onClick={handleOpenInviteMenu}
                          className="text-xs px-2 py-1 rounded-full border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-green-400 hover:text-green-600 dark:hover:border-green-600 dark:hover:text-green-400 transition-colors"
                        >
                          + Invite
                        </button>
                        {showInviteMenu && (
                          <div className="absolute bottom-full left-0 mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] max-h-[200px] overflow-y-auto">
                            {loadingWorkspaces ? (
                              <div className="p-3 text-xs text-gray-400 dark:text-gray-500">Loading workspaces...</div>
                            ) : availableWorkspaces.length === 0 ? (
                              <div className="p-3 text-xs text-gray-400 dark:text-gray-500">No other workspaces available</div>
                            ) : (
                              availableWorkspaces.map(ws => (
                                <button
                                  key={ws.id}
                                  onClick={() => handleInvite(ws)}
                                  className="w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-800 last:border-0"
                                >
                                  {ws.name}
                                </button>
                              ))
                            )}
                            <button
                              onClick={() => setShowInviteMenu(false)}
                              className="w-full text-center text-[10px] py-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 border-t border-gray-100 dark:border-gray-800"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {targetParticipantId ? (
                    /* Sending to a participant */
                    <form onSubmit={handleSendToParticipant} className="flex flex-col gap-2">
                      <textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSendToParticipant(); } }}
                        placeholder={anyParticipantRunning ? 'Advisor is thinking...' : `Ask ${participants.find(p => p.id === targetParticipantId)?.workspace_name || 'advisor'}...`}
                        rows={3}
                        autoFocus
                        disabled={sending || anyParticipantRunning}
                        className="w-full px-3 py-2 border border-teal-300 dark:border-teal-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-y disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={sending || !reply.trim() || anyParticipantRunning}
                        className="bg-teal-600 text-white text-sm px-4 py-2 rounded-md hover:bg-teal-700 disabled:opacity-50 self-end"
                      >
                        {sending ? 'Sending...' : 'Ask Advisor (Ctrl+Enter)'}
                      </button>
                    </form>
                  ) : (
                    /* Sending to the task agent (normal reply) */
                    <form onSubmit={handleReply} className="flex flex-col gap-2">
                      <textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={handleReplyKeyDown}
                        placeholder={anyParticipantRunning ? 'Advisor is thinking...' : 'Reply with feedback...'}
                        rows={3}
                        autoFocus
                        disabled={anyParticipantRunning}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={sending || !reply.trim() || anyParticipantRunning}
                        className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 self-end"
                      >
                        {sending ? 'Sending...' : 'Reply (Ctrl+Enter)'}
                      </button>
                    </form>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleComplete}
                      className="bg-green-600 text-white text-sm px-4 py-2 rounded-md hover:bg-green-700"
                    >
                      Mark Complete (Alt+C)
                    </button>
                    <button
                      onClick={handleRetry}
                      className="bg-gray-600 text-white text-sm px-4 py-2 rounded-md hover:bg-gray-700"
                    >
                      Retry
                    </button>
                    {/* Invite button when no participants yet */}
                    {participants.length === 0 && (
                      <div className="relative">
                        <button
                          onClick={handleOpenInviteMenu}
                          className="text-xs text-green-500 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 ml-2"
                        >
                          + Invite Advisor
                        </button>
                        {showInviteMenu && (
                          <div className="absolute bottom-full left-0 mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] max-h-[200px] overflow-y-auto">
                            {loadingWorkspaces ? (
                              <div className="p-3 text-xs text-gray-400 dark:text-gray-500">Loading workspaces...</div>
                            ) : availableWorkspaces.length === 0 ? (
                              <div className="p-3 text-xs text-gray-400 dark:text-gray-500">No other workspaces available</div>
                            ) : (
                              availableWorkspaces.map(ws => (
                                <button
                                  key={ws.id}
                                  onClick={() => handleInvite(ws)}
                                  className="w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-800 last:border-0"
                                >
                                  {ws.name}
                                </button>
                              ))
                            )}
                            <button
                              onClick={() => setShowInviteMenu(false)}
                              className="w-full text-center text-[10px] py-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 border-t border-gray-100 dark:border-gray-800"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(task.status === 'failed' || task.status === 'cancelled') && (
                <div className="space-y-2">
                  {task.failed_reason?.startsWith('rate_limited:') ? (
                    <RateLimitBanner
                      rateLimit={{
                        resetsAt: parseInt(task.failed_reason.split(':')[1], 10),
                        rateLimitType: 'usage limit',
                      }}
                      onResume={handleRetry}
                      resumeLabel="Retry"
                    />
                  ) : (
                    <>
                      {task.failed_reason && (
                        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-md">
                          {task.failed_reason}
                        </div>
                      )}
                      <button
                        onClick={handleRetry}
                        className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700"
                      >
                        Retry
                      </button>
                    </>
                  )}
                </div>
              )}

              {task.status === 'completed' && (
                <button
                  onClick={handleReopen}
                  className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700"
                >
                  Reopen
                </button>
              )}

              {task.status === 'working' && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleInterrupt}
                    className="bg-amber-500 text-white text-sm px-4 py-2 rounded-md hover:bg-amber-600 font-medium"
                  >
                    Interrupt
                  </button>
                  <button
                    onClick={handleCancel}
                    className="text-sm text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                  >
                    Cancel Task
                  </button>
                </div>
              )}

              {task.status === 'queued' && (
                <button
                  onClick={handleCancel}
                  className="text-sm text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 mt-2"
                >
                  Cancel Task
                </button>
              )}

              {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'awaiting_feedback') && (
                <button
                  onClick={handleDelete}
                  className="text-sm text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 mt-2"
                >
                  Delete Task
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
