import { useState, useEffect, useRef, useMemo, memo, type FormEvent } from 'react';
import {
  getDiscussionDetail,
  getOlderDiscussionMessages,
  sendDiscussionMessage,
  closeDiscussion,
  interruptDiscussion,
  updateDiscussionSession,
  updateDiscussionSettings,
  approveTaskRequest,
  dismissTaskRequest,
  addDiscussionParticipant,
  removeDiscussionParticipant,
  sendParticipantMessage,
  getWorkspaces,
  type Discussion,
  type DiscussionMessage,
  type DiscussionParticipant,
  type TaskRequestItem,
  type Workspace,
} from '../api/client';
import { useDraft } from '../hooks/useDraft';
import { linkify } from '../utils/linkify';
import Markdown from './Markdown';
import RateLimitBanner from './RateLimitBanner';

const TASK_REQUEST_RE = /\[TASK_REQUEST\]\s*[\s\S]*?\s*\[\/TASK_REQUEST\]/g;
const MENTION_RE = /\[MENTION:[^\]]+\]/g;

const MessageRow = memo(function MessageRow({ msg, hostWorkspaceName, participants }: { msg: DiscussionMessage; hostWorkspaceName?: string; participants?: DiscussionParticipant[] }) {
  const strippedContent = msg.role === 'assistant'
    ? msg.content.replace(TASK_REQUEST_RE, '').replace(MENTION_RE, '').trim()
    : msg.content;

  // Determine the label for assistant messages
  const assistantLabel = msg.role === 'assistant'
    ? (msg.username || hostWorkspaceName || 'assistant')
    : null;

  // Determine the recipient label for user messages
  const recipientLabel = msg.role === 'user' && participants && participants.length > 0
    ? (msg.participant_id
        ? participants.find(p => p.id === msg.participant_id)?.workspace_name
        : hostWorkspaceName)
    : null;

  // Color-code participant messages differently from host
  const isParticipantMsg = msg.role === 'assistant' && msg.participant_id;

  return (
    <div
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
          {msg.role === 'user' && msg.username ? msg.username : assistantLabel || msg.role}
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
      <Markdown content={msg.role === 'assistant' ? strippedContent : msg.content} />
    </div>
  );
});

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

interface DiscussionModalProps {
  discussionId: string;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onTaskCreated?: () => void;
}

export default function DiscussionModal({ discussionId, workspaceId, workspaceName, onClose, onTaskCreated }: DiscussionModalProps) {
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [taskRequests, setTaskRequests] = useState<TaskRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage, clearMessage] = useDraft(`discussion:${discussionId}`);
  const [sending, setSending] = useState(false);
  const [editingSession, setEditingSession] = useState(false);
  const [sessionIdDraft, setSessionIdDraft] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [processingRequest, setProcessingRequest] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const shouldForceScroll = useRef(false);
  const prevMessageCount = useRef(0);

  const [totalMessages, setTotalMessages] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastDiscJsonRef = useRef('');
  const lastTrJsonRef = useRef('');
  const discussionRunningRef = useRef(false);
  const lastMessageIdRef = useRef<string | null>(null);
  const initialLoadDone = useRef(false);

  // Multi-agent participant state
  const [participants, setParticipants] = useState<DiscussionParticipant[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null); // null = host
  const [showInviteMenu, setShowInviteMenu] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const lastParticipantsJsonRef = useRef('');

  // Initial load: fetch latest 50 messages
  // Subsequent polls: only fetch messages after the last known ID
  const loadData = async () => {
    try {
      const afterId = initialLoadDone.current ? lastMessageIdRef.current || undefined : undefined;
      const data = await getDiscussionDetail(discussionId, afterId || undefined);

      // Update discussion metadata
      const dJson = JSON.stringify(data.discussion);
      if (dJson !== lastDiscJsonRef.current) {
        lastDiscJsonRef.current = dJson;
        setDiscussion(data.discussion);
        // Running means host OR any participant is running
        const anyParticipantRunning = (data.participants || []).some(p => p.running);
        discussionRunningRef.current = !!data.discussion?.running || anyParticipantRunning;
      }

      // Update participants
      const pJson = JSON.stringify(data.participants || []);
      if (pJson !== lastParticipantsJsonRef.current) {
        lastParticipantsJsonRef.current = pJson;
        setParticipants(data.participants || []);
      }

      setTotalMessages(data.totalMessages);

      // Update task requests
      const trJson = JSON.stringify(data.taskRequests);
      if (trJson !== lastTrJsonRef.current) {
        lastTrJsonRef.current = trJson;
        setTaskRequests(data.taskRequests);
      }

      // Messages
      if (!initialLoadDone.current) {
        // First load — set all messages
        setMessages(data.messages);
        if (data.messages.length > 0) {
          lastMessageIdRef.current = data.messages[data.messages.length - 1].id;
        }
        initialLoadDone.current = true;
      } else if (data.messages.length > 0) {
        // Incremental — append new messages
        setMessages(prev => [...prev, ...data.messages]);
        lastMessageIdRef.current = data.messages[data.messages.length - 1].id;
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const loadOlderMessages = async () => {
    if (loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const scrollEl = scrollBodyRef.current;
      const prevScrollHeight = scrollEl?.scrollHeight || 0;

      const { messages: older } = await getOlderDiscussionMessages(discussionId, messages[0].id, 50);
      if (older.length > 0) {
        setMessages(prev => [...older, ...prev]);
        // Preserve scroll position after prepending
        requestAnimationFrame(() => {
          if (scrollEl) {
            scrollEl.scrollTop += scrollEl.scrollHeight - prevScrollHeight;
          }
        });
      }
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      loadData().finally(() => {
        if (!cancelled) timer = setTimeout(tick, discussionRunningRef.current ? 3000 : 10000);
      });
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [discussionId]);

  // Scroll to bottom
  useEffect(() => {
    if (!loading && scrollBodyRef.current) {
      const el = scrollBodyRef.current;
      const newMessages = messages.length > prevMessageCount.current;
      prevMessageCount.current = messages.length;

      if (!initialScrollDone.current) {
        // Double-rAF ensures DOM is fully painted before scrolling
        requestAnimationFrame(() => { requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); });
        initialScrollDone.current = true;
      } else if (shouldForceScroll.current) {
        shouldForceScroll.current = false;
        requestAnimationFrame(() => { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); });
      } else if (newMessages) {
        // Auto-scroll on new messages if user hasn't scrolled far up
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;
        if (isNearBottom) {
          requestAnimationFrame(() => { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); });
        }
      }
    }
  }, [loading, messages.length]);

  // Browser back button
  useEffect(() => {
    window.history.pushState({ modal: 'discussion' }, '');
    const handlePopState = () => { onClose(); };
    window.addEventListener('popstate', handlePopState);
    return () => { window.removeEventListener('popstate', handlePopState); };
  }, []);

  // Memoize filtered message list so we don't re-filter/re-render on every poll
  const visibleMessages = useMemo(() =>
    messages.filter((msg) => {
      if (msg.role === 'assistant') {
        const stripped = msg.content.replace(TASK_REQUEST_RE, '').trim();
        if (!stripped) return false;
      }
      return true;
    }),
    [messages]
  );

  // Computed: is any agent (host or participant) running?
  const isAnyRunning = !!(discussion?.running) || participants.some(p => p.running);
  const runningParticipant = participants.find(p => p.running);
  const runningAgentName = discussion?.running ? workspaceName : runningParticipant?.workspace_name || null;

  // Target display name
  const targetName = targetId
    ? participants.find(p => p.id === targetId)?.workspace_name || 'participant'
    : workspaceName;

  const handleSwitchTarget = (newTargetId: string | null) => {
    if (newTargetId === targetId) return;
    if (isAnyRunning || sending) return;
    setTargetId(newTargetId);
  };

  const handleInvite = async (ws: Workspace) => {
    try {
      await addDiscussionParticipant(discussionId, ws.id, ws.name);
      setShowInviteMenu(false);
      await loadData();
    } catch (err) {
      console.error('Failed to invite:', err);
    }
  };

  const handleRemoveParticipant = async (participantId: string) => {
    try {
      await removeDiscussionParticipant(discussionId, participantId);
      if (targetId === participantId) setTargetId(null);
      await loadData();
    } catch (err) {
      console.error('Failed to remove participant:', err);
    }
  };

  const handleOpenInviteMenu = async () => {
    setShowInviteMenu(true);
    setLoadingWorkspaces(true);
    try {
      const data = await getWorkspaces();
      setAvailableWorkspaces(data.workspaces.filter(ws =>
        ws.id !== workspaceId && // not the host
        !participants.some(p => p.workspace_id === ws.id) // not already invited
      ));
    } catch {
      setAvailableWorkspaces([]);
    } finally {
      setLoadingWorkspaces(false);
    }
  };

  const closeModal = () => {
    if (window.history.state?.modal === 'discussion') {
      window.history.back();
    } else {
      onClose();
    }
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSend = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    shouldForceScroll.current = true;
    try {
      if (targetId) {
        // Send to participant
        await sendParticipantMessage(discussionId, targetId, message.trim());
      } else {
        // Send to host
        await sendDiscussionMessage(discussionId, message.trim());
      }
      clearMessage();
      await loadData();
    } catch (err) {
      // Show error inline
      if (err instanceof Error && err.message.includes('currently processing')) {
        // Don't clear message, let user retry
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClose = async () => {
    if (!confirm('Close this discussion? You can start a new one later.')) return;
    await closeDiscussion(discussionId);
    onClose();
  };

  const handleApprove = async (requestId: string) => {
    if (processingRequest) return;
    setProcessingRequest(requestId);
    try {
      await approveTaskRequest(discussionId, requestId);
      onTaskCreated?.();
      await loadData();
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleDismiss = async (requestId: string) => {
    if (processingRequest) return;
    setProcessingRequest(requestId);
    try {
      await dismissTaskRequest(discussionId, requestId);
      await loadData();
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleToggleFullAccess = async () => {
    if (!discussion || discussion.running) return;
    const newValue = !discussion.full_access;
    try {
      await updateDiscussionSettings(workspaceId, newValue);
      // Update local state immediately
      setDiscussion({ ...discussion, full_access: newValue ? 1 : 0 });
    } catch {
      // ignore
    }
  };

  const handleEditSession = () => {
    setSessionIdDraft(discussion?.claude_session_id || '');
    setSessionError('');
    setEditingSession(true);
  };

  const handleSaveSession = async () => {
    const trimmed = sessionIdDraft.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(trimmed)) {
      setSessionError('Invalid UUID format');
      return;
    }
    try {
      await updateDiscussionSession(discussionId, trimmed);
      setEditingSession(false);
      setSessionError('');
      await loadData();
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to update');
    }
  };

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
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading discussion...</div>
        ) : !discussion ? (
          <div className="p-8 text-center text-red-600 dark:text-red-400">Discussion not found</div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-200 dark:border-gray-800">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Discussion</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
                    {discussion.running ? 'thinking...' : 'active'}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">{workspaceName}</span>
                  {discussion.model && (
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      discussion.model.startsWith('ollama/')
                        ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                        : 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
                    }`}>
                      {discussion.model.startsWith('ollama/')
                        ? discussion.model.slice('ollama/'.length).replace(/:latest$/, '')
                        : discussion.model.replace(/^claude-/, '')}
                    </span>
                  )}
                  {discussion.running && discussion.activity && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      Last activity {timeAgo(discussion.activity.timestamp)}
                    </span>
                  )}
                </div>
                {/* Session UUID */}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide shrink-0">Session</span>
                  {editingSession ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <input
                        type="text"
                        value={sessionIdDraft}
                        onChange={(e) => { setSessionIdDraft(e.target.value); setSessionError(''); }}
                        className="flex-1 min-w-0 text-[11px] font-mono px-1.5 py-0.5 border border-purple-300 dark:border-purple-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
                        spellCheck={false}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveSession(); if (e.key === 'Escape') setEditingSession(false); }}
                      />
                      <button onClick={handleSaveSession} className="text-[10px] px-1.5 py-0.5 bg-purple-600 text-white rounded hover:bg-purple-700" title="Save">Save</button>
                      <button onClick={() => setEditingSession(false)} className="text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Cancel">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 min-w-0">
                      <code className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate" title={discussion.claude_session_id || 'none'}>
                        {discussion.claude_session_id || 'none'}
                      </code>
                      <button
                        onClick={handleEditSession}
                        className="text-[10px] text-purple-500 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 shrink-0"
                        title="Edit session ID"
                      >
                        edit
                      </button>
                    </div>
                  )}
                </div>
                {sessionError && (
                  <p className="text-[10px] text-red-500 mt-0.5">{sessionError}</p>
                )}
                {/* Full Access toggle */}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide shrink-0">Access</span>
                  <button
                    onClick={handleToggleFullAccess}
                    disabled={discussion.running}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                      discussion.full_access ? 'bg-amber-500' : 'bg-gray-300 dark:bg-gray-600'
                    } ${discussion.running ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    title={discussion.full_access ? 'Full access — Claude can modify files' : 'Read-only — Claude can only read and explore'}
                  >
                    <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                      discussion.full_access ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`} />
                  </button>
                  <span className={`text-[10px] ${discussion.full_access ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}>
                    {discussion.full_access ? 'Full Access' : 'Read-Only'}
                  </span>
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
              {messages.length === 0 && !discussion.running && (
                <div className="text-center text-gray-400 dark:text-gray-500 text-sm py-8">
                  Start a conversation about this workspace. Claude can read code but won't modify anything.
                </div>
              )}

              {totalMessages > messages.length && (
                <div className="text-center py-2">
                  <button
                    onClick={loadOlderMessages}
                    disabled={loadingOlder}
                    className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-50"
                  >
                    {loadingOlder ? 'Loading...' : `Load earlier messages (${totalMessages - messages.length} more)`}
                  </button>
                </div>
              )}

              {visibleMessages.map((msg) => (
                <MessageRow key={msg.id} msg={msg} hostWorkspaceName={workspaceName} participants={participants} />
              ))}

              {/* Working indicator */}
              {isAnyRunning && (
                <div className={`text-sm p-4 rounded-lg border ${
                  runningParticipant
                    ? 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20 border-teal-100 dark:border-teal-800'
                    : 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800'
                }`}>
                  <div className="flex items-center gap-2">
                    <div className={`animate-spin h-4 w-4 border-2 border-t-transparent rounded-full ${
                      runningParticipant ? 'border-teal-600 dark:border-teal-400' : 'border-purple-600 dark:border-purple-400'
                    }`} />
                    <span>{runningAgentName || 'Agent'} is thinking...</span>
                    {(discussion.activity || runningParticipant?.activity) && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                        {timeAgo((runningParticipant?.activity || discussion.activity)!.timestamp)}
                      </span>
                    )}
                    <button
                      onClick={async () => {
                        try { await interruptDiscussion(discussionId); } catch {}
                      }}
                      className="ml-auto text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 p-1 rounded hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
                      title="Interrupt"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {(discussion.activity || runningParticipant?.activity) && (
                    <p className={`mt-1 text-xs truncate ml-6 ${
                      runningParticipant ? 'text-teal-500 dark:text-teal-300' : 'text-purple-500 dark:text-purple-300'
                    }`}>
                      {linkify((runningParticipant?.activity || discussion.activity)!.summary)}
                    </p>
                  )}
                </div>
              )}

              {/* Rate limit banner */}
              {!discussion.running && discussion.rate_limit && (
                <RateLimitBanner
                  rateLimit={discussion.rate_limit}
                  resumeLabel="Send again"
                />
              )}

              {/* Pending task requests */}
              {taskRequests.map((tr) => (
                <div
                  key={tr.id}
                  className="rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-400 uppercase">Proposed Task</span>
                  </div>
                  <p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap mb-2">{tr.prompt}</p>
                  {tr.branch && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">Branch: {tr.branch}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(tr.id)}
                      disabled={processingRequest !== null}
                      className="text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {processingRequest === tr.id ? 'Creating...' : 'Create Task'}
                    </button>
                    <button
                      onClick={() => handleDismiss(tr.id)}
                      disabled={processingRequest !== null}
                      className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {processingRequest === tr.id ? 'Dismissing...' : 'Dismiss'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer: target selector + message input + actions */}
            <div className="border-t border-gray-200 dark:border-gray-800 p-5">
              {/* Target selector — only shown when there are participants */}
              {participants.length > 0 && (
                <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide mr-1">Talk to:</span>
                  {/* Host tab */}
                  <button
                    onClick={() => handleSwitchTarget(null)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      targetId === null
                        ? 'bg-purple-100 dark:bg-purple-900/40 border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 font-medium'
                        : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-purple-300 dark:hover:border-purple-700'
                    }`}
                  >
                    {workspaceName}
                    {discussion.running && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-500 animate-pulse" />}
                  </button>
                  {/* Participant tabs */}
                  {participants.map(p => (
                    <div key={p.id} className="flex items-center gap-0">
                      <button
                        onClick={() => handleSwitchTarget(p.id)}
                        className={`text-xs px-2.5 py-1 rounded-l-full border transition-colors ${
                          targetId === p.id
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
                  {/* Invite button */}
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

              <form onSubmit={handleSend} className="flex flex-col gap-2">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isAnyRunning ? `${runningAgentName || 'Agent'} is thinking...` : `Message ${targetName}...`}
                  rows={3}
                  autoFocus
                  disabled={sending || isAnyRunning}
                  className={`w-full px-3 py-2 border bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 resize-y disabled:opacity-50 ${
                    targetId
                      ? 'border-teal-300 dark:border-teal-700 focus:ring-teal-500'
                      : 'border-gray-300 dark:border-gray-700 focus:ring-purple-500'
                  }`}
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleClose}
                      className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    >
                      End Discussion
                    </button>
                    {/* Invite button when no participants yet */}
                    {participants.length === 0 && (
                      <div className="relative">
                        <button
                          onClick={handleOpenInviteMenu}
                          className="text-xs text-green-500 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300"
                        >
                          + Invite Agent
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
                  <button
                    type="submit"
                    disabled={sending || !message.trim() || isAnyRunning}
                    className={`text-white text-sm px-4 py-2 rounded-md disabled:opacity-50 ${
                      targetId
                        ? 'bg-teal-600 hover:bg-teal-700'
                        : 'bg-purple-600 hover:bg-purple-700'
                    }`}
                  >
                    {sending ? 'Sending...' : `Send to ${targetName} (Ctrl+Enter)`}
                  </button>
                </div>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
