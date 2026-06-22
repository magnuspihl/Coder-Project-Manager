import React, { useState, useEffect, useRef, useMemo, useCallback, type FormEvent } from 'react';
import {
  getTaskDetail,
  getStreamLog,
  replyToTask,
  completeTask,
  reopenTask,
  retryTask,
  resetTaskSession,
  compactTaskSession,
  updateTaskTitle,
  interruptTask,
  cancelTask,
  deleteTask,
  addTaskParticipant,
  removeTaskParticipant,
  sendTaskParticipantMessage,
  sendTaskParticipantCatchUp,
  getWorkspaces,
  uploadFiles,
  getWorkspaceVoiceSettings,
  touchTask,
  approveTaskRequestForTask,
  dismissTaskRequestForTask,
  updateTaskRequestTargetForTask,
  type Task,
  type Message,
  type StreamLogEntry,
  type TaskParticipant,
  type TaskTurn,
  type Workspace,
  type AttachmentInfo,
  type TaskRequestItem,
} from '../api/client';
import { playChime } from '../utils/chime';
import { playListenChime } from '../utils/listenChime';
import RateLimitBanner from './RateLimitBanner';
import { useDraft } from '../hooks/useDraft';
import { useWorkspacePreview } from '../hooks/useWorkspacePreview';
import WorkspacePreviewPanel, { PreviewToggleButton } from './WorkspacePreviewPanel';
import { linkify } from '../utils/linkify';
import Markdown from './Markdown';
import { useTTSVoice } from '../hooks/useTTSVoice';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { useVoiceMode } from '../hooks/useVoiceMode';

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
  const [optimisticMessage, setOptimisticMessage] = useState<Message | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [resetSessionOpen, setResetSessionOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [resetSessionPrompt, setResetSessionPrompt] = useState('');
  const [resettingSession, setResettingSession] = useState(false);
  const [compactingSession, setCompactingSession] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editingTitleRef = useRef(false);
  editingTitleRef.current = editingTitle;
  const skipNextTitleBlurRef = useRef(false);
  const [turns, setTurns] = useState<TaskTurn[]>([]);
  const [participants, setParticipants] = useState<TaskParticipant[]>([]);
  const [taskRequests, setTaskRequests] = useState<TaskRequestItem[]>([]);
  const [processingRequest, setProcessingRequest] = useState<string | null>(null);
  const [requestTargetOverride, setRequestTargetOverride] = useState<Record<string, string>>({});
  const [allRunningWorkspaces, setAllRunningWorkspaces] = useState<Workspace[] | null>(null);
  const [targetParticipantId, setTargetParticipantId] = useState<string | null>(null);
  const [showInviteMenu, setShowInviteMenu] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadedAttachmentIds, setUploadedAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  // Reviewer turns render collapsed: just a pass/fail summary by default. The
  // full reviewer prose is hidden behind a per-turn "details" toggle.
  const [expandedReviews, setExpandedReviews] = useState<Set<string>>(new Set());
  const [applyingFixes, setApplyingFixes] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastParticipantsJsonRef = useRef('');

  // @-mention autocomplete. Same shape and behavior as DiscussionModal — when
  // there are participants, typing '@' (or tapping the "@ Mention" pill on
  // mobile) opens a picker for inserting an agent name into the reply.
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const [mentionMenu, setMentionMenu] = useState<{
    open: boolean;
    anchorStart: number;
    query: string;
    selectedIndex: number;
  }>({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
  const prevStatusRef = useRef<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const maxStreamLogIdRef = useRef(0);

  const lastTaskJsonRef = useRef('');
  const lastMessagesJsonRef = useRef('');
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Voice state
  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const prevIsAnyRunningRef = useRef(false);
  const voicePendingSendRef = useRef(false);
  const [conversationMode, setConversationMode] = useState(() => localStorage.getItem('voice:conversation') === '1');
  const conversationModeRef = useRef(conversationMode);
  conversationModeRef.current = conversationMode;
  const lastAutoSpokenMsgIdRef = useRef<string | null>(null);
  const prevTtsSpeakingIdRef = useRef<string | null>(null);
  const [touchResult, setTouchResult] = useState<{ previousOpenedAt: string | null } | null>(null);
  const playOnOpenDoneRef = useRef(false);


  const toggleConversationMode = useCallback(() => {
    setConversationMode(v => {
      const next = !v;
      localStorage.setItem('voice:conversation', next ? '1' : '0');
      return next;
    });
  }, []);

  const { voices: ttsVoices, speakAs: ttsSpeakAs, stopSpeaking: ttsStop, speakingId: ttsSpeakingId, warmupQwen, kokoroLoading, kokoroProgress } = useTTSVoice();
  const [wsVoiceSettings, setWsVoiceSettings] = useState<Record<string, string[]>>({});
  const wsVoiceSettingsRef = useRef(wsVoiceSettings);
  wsVoiceSettingsRef.current = wsVoiceSettings;
  const [wsDefaultVoices, setWsDefaultVoices] = useState<Record<string, string | null>>({});
  const wsDefaultVoicesRef = useRef(wsDefaultVoices);
  wsDefaultVoicesRef.current = wsDefaultVoices;

  const handleRecorderTranscript = useCallback((text: string) => {
    setReply(text);
    if (conversationModeRef.current) voicePendingSendRef.current = true;
  }, [setReply]);

  const recorder = useVoiceRecorder({ onTranscript: handleRecorderTranscript });
  const speechRec = useVoiceMode({
    onTranscript: useCallback((t: string) => setReply(t), [setReply]),
    onSilenceTimeout: useCallback((t: string) => {
      setReply(t);
      if (conversationModeRef.current) voicePendingSendRef.current = true;
    }, [setReply]),
  });

  const useWhisper = recorder.isSupported;
  const voiceSupported = useWhisper || speechRec.isSupported;
  const isListening = useWhisper ? recorder.isRecording : speechRec.isListening;
  const isTranscribing = useWhisper ? recorder.isTranscribing : false;
  const voiceDebug = useWhisper ? recorder.debugStatus : speechRec.debugStatus;

  const startListening = useCallback(() => {
    if (useWhisper) recorder.startRecording();
    else speechRec.startListening();
  }, [useWhisper, recorder.startRecording, speechRec.startListening]);

  const stopListening = useCallback(() => {
    if (useWhisper) recorder.stopRecording();
    else speechRec.stopListening();
  }, [useWhisper, recorder.stopRecording, speechRec.stopListening]);

  const loadData = async () => {
    try {
      const { task: newTask, messages: newMessages, participants: newParticipants, attachments: newAttachments, turns: newTurns, taskRequests: newTaskRequests } = await getTaskDetail(taskId);
      setTaskRequests(newTaskRequests || []);
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
      if (newAttachments) setAttachments(newAttachments);
      if (newTurns) setTurns(newTurns);
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
  }, [loading, messages.length, streamLog.length, optimisticMessage?.id]);

  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamLog.length, logOpen]);

  // Clear the optimistic reply once a matching real message arrives — either
  // via the explicit reload after send, or via a polling tick that races the
  // in-flight send. Without this, the optimistic and the real message both
  // render until the API call's finally clears the optimistic.
  useEffect(() => {
    if (!optimisticMessage) return;
    const optTime = new Date(optimisticMessage.created_at).getTime();
    const matched = messages.some(m =>
      m.role === 'user' &&
      m.content === optimisticMessage.content &&
      m.participant_id === optimisticMessage.participant_id &&
      new Date(m.created_at).getTime() >= optTime - 60_000,
    );
    if (matched) setOptimisticMessage(null);
  }, [messages, optimisticMessage]);

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

  // Touch the task on mount to record open time and get previous open time
  useEffect(() => {
    touchTask(taskId)
      .then(setTouchResult)
      .catch(() => setTouchResult({ previousOpenedAt: null }));
  }, [taskId]);

  const preview = useWorkspacePreview(task?.workspace_id ?? null, taskId, task?.port_range_start ?? null);

  // Play-on-open: once initial load is done, speak assistant messages newer than previousOpenedAt
  useEffect(() => {
    if (playOnOpenDoneRef.current) return;
    if (!touchResult || loading || !conversationMode || ttsVoices.length === 0) return;
    playOnOpenDoneRef.current = true;
    if (touchResult.previousOpenedAt === null) return; // first ever open — nothing to speak

    const threshold = touchResult.previousOpenedAt;
    const newMsgs = messages.filter(
      m => m.role === 'assistant' && m.created_at > threshold
    );
    if (newMsgs.length === 0) return;

    // Speak just the most recent new message (consistent with normal auto-speak behavior)
    const m = newMsgs[newMsgs.length - 1];
    lastAutoSpokenMsgIdRef.current = m.id;
    const wsId = m.participant_id
      ? (participantsRef.current.find(p => p.id === m.participant_id)?.workspace_id ?? task?.workspace_id ?? '')
      : (task?.workspace_id ?? '');
    const explicit = wsVoiceSettingsRef.current[wsId] ?? [];
    const def = wsDefaultVoicesRef.current[wsId];
    const voiceIds = def && !explicit.includes(def) ? [...explicit, def] : explicit;
    ttsSpeakAs(m.content, m.id, voiceIds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchResult, loading, conversationMode, ttsVoices.length, messages]);

  const closeModal = () => {
    onClose();
  };

  // Keyboard shortcuts: Escape to close, Alt+C to mark complete
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // While editing the title, Escape cancels the edit; the input's own
        // handler manages that. Don't also close the modal.
        if (editingTitleRef.current) return;
        closeModal();
      }
      if (e.altKey && e.key === 'c' && taskStatusRef.current === 'awaiting_feedback' && !completing) {
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

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files);
    setPendingFiles(prev => [...prev, ...newFiles]);
    setUploading(true);
    try {
      const uploaded = await uploadFiles(newFiles);
      setUploadedAttachmentIds(prev => [...prev, ...uploaded.map(a => a.id)]);
    } catch {
      setPendingFiles(prev => prev.filter(f => !newFiles.includes(f)));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemovePendingFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
    setUploadedAttachmentIds(prev => prev.filter((_, i) => i !== index));
  };

  const handleReply = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = reply.trim();
    if (!trimmed && uploadedAttachmentIds.length === 0) return;
    setSending(true);
    const attIds = uploadedAttachmentIds.length > 0 ? uploadedAttachmentIds : undefined;
    clearReply();
    setPendingFiles([]);
    setUploadedAttachmentIds([]);
    setOptimisticMessage({
      id: `optimistic-${Date.now()}`,
      task_id: taskId,
      role: 'user',
      content: trimmed || 'See attached files.',
      cost: null,
      username: null,
      participant_id: null,
      turn_id: null,
      created_at: new Date().toISOString(),
    });
    try {
      await replyToTask(taskId, trimmed || 'See attached files.', attIds);
      closeAndNotify();
    } catch {
      setReply(trimmed);
    } finally {
      setSending(false);
      setOptimisticMessage(null);
    }
  };

  const mentionCandidates = useMemo(() => {
    const hostName = task?.workspace_name;
    const names = [hostName, ...participants.map(p => p.workspace_name)].filter(
      (n): n is string => typeof n === 'string' && n.length > 0,
    );
    return Array.from(new Set(names));
  }, [task?.workspace_name, participants]);

  const mentionMatches = useMemo(() => {
    if (!mentionMenu.open) return [];
    const q = mentionMenu.query.toLowerCase();
    if (!q) return mentionCandidates;
    return mentionCandidates.filter(n => n.toLowerCase().includes(q));
  }, [mentionMenu.open, mentionMenu.query, mentionCandidates]);

  const detectMention = (text: string, caret: number): { start: number; query: string } | null => {
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        if (i === 0 || /\s/.test(text[i - 1])) {
          const query = text.slice(i + 1, caret);
          if (/\s/.test(query)) return null;
          return { start: i, query };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  };

  const refreshMentionMenu = useCallback((value: string, caret: number) => {
    if (participants.length === 0) {
      if (mentionMenu.open) setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
      return;
    }
    const ctx = detectMention(value, caret);
    if (ctx) {
      setMentionMenu(prev => ({
        open: true,
        anchorStart: ctx.start,
        query: ctx.query,
        selectedIndex: prev.open && prev.query === ctx.query ? prev.selectedIndex : 0,
      }));
    } else if (mentionMenu.open) {
      setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
    }
  }, [participants.length, mentionMenu.open]);

  const handleReplyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setReply(value);
    if (isComposingRef.current) return;
    const caret = e.target.selectionStart ?? value.length;
    refreshMentionMenu(value, caret);
  };

  const handleReplyCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    const el = e.currentTarget;
    refreshMentionMenu(el.value, el.selectionStart ?? el.value.length);
  };

  const handleReplySelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;
    const el = e.currentTarget;
    refreshMentionMenu(el.value, el.selectionStart ?? el.value.length);
  };

  const openMentionMenu = () => {
    const el = replyTextareaRef.current;
    const caret = el?.selectionStart ?? reply.length;
    const before = reply.slice(0, caret);
    const after = reply.slice(caret);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsLeadingSpace ? ' ' : '') + '@';
    const next = before + insert + after;
    const atIndex = before.length + insert.length - 1;
    setReply(next);
    setMentionMenu({ open: true, anchorStart: atIndex, query: '', selectedIndex: 0 });
    requestAnimationFrame(() => {
      const t = replyTextareaRef.current;
      if (!t) return;
      t.focus();
      const c = atIndex + 1;
      t.setSelectionRange(c, c);
    });
  };

  const insertMention = (name: string) => {
    if (!mentionMenu.open || mentionMenu.anchorStart < 0) return;
    const before = reply.slice(0, mentionMenu.anchorStart);
    const caret = replyTextareaRef.current?.selectionStart ?? reply.length;
    const after = reply.slice(caret);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setReply(next);
    setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
    const newCaret = before.length + inserted.length;
    requestAnimationFrame(() => {
      const el = replyTextareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
    });
  };

  const handleReplyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMenu.open && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionMenu(m => ({ ...m, selectedIndex: (m.selectedIndex + 1) % mentionMatches.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionMenu(m => ({
          ...m,
          selectedIndex: (m.selectedIndex - 1 + mentionMatches.length) % mentionMatches.length,
        }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = mentionMatches[Math.min(mentionMenu.selectedIndex, mentionMatches.length - 1)];
        if (pick) insertMention(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleReply();
    }
  };

  // Variant used by the "Send to participant" textarea — same mention-menu
  // behavior, but Ctrl/Cmd+Enter submits to the participant form instead.
  const handleParticipantReplyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMenu.open && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionMenu(m => ({ ...m, selectedIndex: (m.selectedIndex + 1) % mentionMatches.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionMenu(m => ({
          ...m,
          selectedIndex: (m.selectedIndex - 1 + mentionMatches.length) % mentionMatches.length,
        }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = mentionMatches[Math.min(mentionMenu.selectedIndex, mentionMatches.length - 1)];
        if (pick) insertMention(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSendToParticipant();
    }
  };

  // Reusable mention-dropdown JSX. Rendered above whichever textarea is active.
  const mentionDropdown = mentionMenu.open && mentionMatches.length > 0 ? (
    <div
      className="absolute bottom-full left-0 mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] max-h-[200px] overflow-y-auto"
      role="listbox"
    >
      <div className="px-3 py-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
        Mention agent
      </div>
      {mentionMatches.map((name, idx) => {
        const isHost = name === task?.workspace_name;
        const isSelected = idx === mentionMenu.selectedIndex;
        return (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={isSelected}
            onMouseDown={(e) => {
              e.preventDefault();
              insertMention(name);
            }}
            onMouseEnter={() => setMentionMenu(m => ({ ...m, selectedIndex: idx }))}
            className={`w-full text-left text-xs px-3 py-2 flex items-center gap-2 ${
              isSelected
                ? isHost
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${isHost ? 'bg-blue-500' : 'bg-teal-500'}`} />
            <span className="font-medium">{name}</span>
            {isHost && (
              <span className="ml-auto text-[10px] uppercase opacity-60">task agent</span>
            )}
          </button>
        );
      })}
    </div>
  ) : null;

  // Like handleReply but stays in the modal — used by voice auto-send so the
  // conversation loop continues instead of closing the task detail view.
  const replyAndStay = useCallback(async () => {
    const trimmed = reply.trim();
    if (!trimmed && uploadedAttachmentIds.length === 0) return;
    if (sending) return;
    setSending(true);
    const attIds = uploadedAttachmentIds.length > 0 ? uploadedAttachmentIds : undefined;
    clearReply();
    setPendingFiles([]);
    setUploadedAttachmentIds([]);
    setOptimisticMessage({
      id: `optimistic-${Date.now()}`,
      task_id: taskId,
      role: 'user',
      content: trimmed || 'See attached files.',
      cost: null,
      username: null,
      participant_id: null,
      turn_id: null,
      created_at: new Date().toISOString(),
    });
    try {
      await replyToTask(taskId, trimmed || 'See attached files.', attIds);
      onTaskChanged?.();
      await loadData();
    } catch {
      setReply(trimmed);
    } finally { setSending(false); setOptimisticMessage(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply, uploadedAttachmentIds, sending, taskId]);

  const parseIssues = (turn: TaskTurn): string[] => {
    if (!turn.review_issues) return [];
    try {
      const parsed = JSON.parse(turn.review_issues);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  };

  const toggleReviewDetails = (turnId: string) => {
    setExpandedReviews(prev => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };

  // "Apply suggested fixes" — resume the implementer with the reviewer's issues.
  // Replying resets the review loop, so the new turn gets a fresh review.
  const handleApplyFixes = async (turn: TaskTurn) => {
    if (applyingFixes || sending) return;
    const issues = parseIssues(turn);
    const body = issues.length > 0
      ? `Please apply fixes for the issues the reviewer found:\n\n${issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : `Please apply the fixes the reviewer suggested${turn.review_summary ? `: ${turn.review_summary}` : '.'}`;
    setApplyingFixes(true);
    try {
      await replyToTask(taskId, body);
      onTaskChanged?.();
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to apply fixes');
    } finally {
      setApplyingFixes(false);
    }
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await completeTask(taskId);
      closeAndNotify();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('uncommitted')) {
        alert(err.message);
      } else {
        closeAndNotify();
      }
    } finally {
      setCompleting(false);
    }
  };

  const handleRetry = async () => {
    await retryTask(taskId);
    closeAndNotify();
  };

  const handleResetSession = async () => {
    const trimmed = resetSessionPrompt.trim();
    if (!trimmed) return;
    setResettingSession(true);
    try {
      await resetTaskSession(taskId, trimmed);
      setResetSessionOpen(false);
      setResetSessionPrompt('');
      closeAndNotify();
    } catch (err: any) {
      alert(err?.message || 'Failed to reset session');
    } finally {
      setResettingSession(false);
    }
  };

  const handleCompactSession = async () => {
    setCompactingSession(true);
    try {
      await compactTaskSession(taskId);
      closeAndNotify();
    } catch (err: any) {
      alert(err?.message || 'Failed to compact session');
    } finally {
      setCompactingSession(false);
    }
  };

  const handleReopen = async () => {
    await reopenTask(taskId);
    closeAndNotify();
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

  const startEditTitle = () => {
    if (!task) return;
    setTitleDraft(task.title);
    setEditingTitle(true);
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
  };

  const cancelEditTitle = () => {
    skipNextTitleBlurRef.current = true;
    setEditingTitle(false);
    setTitleDraft('');
  };

  const saveTitle = async () => {
    if (skipNextTitleBlurRef.current) {
      skipNextTitleBlurRef.current = false;
      return;
    }
    if (!task) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === task.title) {
      cancelEditTitle();
      return;
    }
    setSavingTitle(true);
    try {
      const { task: updated } = await updateTaskTitle(taskId, trimmed);
      setTask(prev => (prev ? { ...prev, title: updated.title } : prev));
      lastTaskJsonRef.current = '';
      setEditingTitle(false);
      setTitleDraft('');
      onTaskChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to update title');
    } finally {
      setSavingTitle(false);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditTitle();
    }
  };

  // Load the full list of running workspaces when a pending task request needs a target selector
  useEffect(() => {
    if (taskRequests.length === 0 || allRunningWorkspaces !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const { workspaces } = await getWorkspaces();
        if (!cancelled) {
          setAllRunningWorkspaces(workspaces.filter(ws => ws.latest_build?.status === 'running'));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [taskRequests.length, allRunningWorkspaces]);

  // Task request (delegation) handlers
  const handleApproveRequest = async (requestId: string, targetWorkspaceId: string | null, targetName: string) => {
    if (processingRequest) return;
    if (targetWorkspaceId && targetWorkspaceId !== task?.workspace_id) {
      const ok = confirm(
        `This task will run in "${targetName}", a DIFFERENT workspace from this task ("${task?.workspace_name}"). ` +
        `It will be queued there and run with that workspace's project context. Continue?`
      );
      if (!ok) return;
    }
    setProcessingRequest(requestId);
    try {
      await approveTaskRequestForTask(taskId, requestId, targetWorkspaceId);
      onTaskChanged?.();
      await loadData();
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleChangeRequestTarget = async (requestId: string, targetWorkspaceId: string) => {
    setRequestTargetOverride(prev => ({ ...prev, [requestId]: targetWorkspaceId }));
    try {
      await updateTaskRequestTargetForTask(taskId, requestId, targetWorkspaceId === task?.workspace_id ? null : targetWorkspaceId);
    } catch (err) {
      console.error('Failed to update task request target:', err);
    }
  };

  const handleDismissRequest = async (requestId: string) => {
    if (processingRequest) return;
    setProcessingRequest(requestId);
    try {
      await dismissTaskRequestForTask(taskId, requestId);
      await loadData();
    } finally {
      setProcessingRequest(null);
    }
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

  const handleParticipantCatchUp = async (participantId: string) => {
    try {
      await sendTaskParticipantCatchUp(taskId, participantId);
      await loadData();
    } catch { /* ignore */ }
  };

  const handleSendToParticipant = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = reply.trim();
    if (!trimmed || !targetParticipantId) return;
    setSending(true);
    clearReply();
    setOptimisticMessage({
      id: `optimistic-${Date.now()}`,
      task_id: taskId,
      role: 'user',
      content: trimmed,
      cost: null,
      username: null,
      participant_id: targetParticipantId,
      turn_id: null,
      created_at: new Date().toISOString(),
    });
    try {
      await sendTaskParticipantMessage(taskId, targetParticipantId, trimmed);
      await loadData();
    } catch {
      setReply(trimmed);
    } finally {
      setSending(false);
      setOptimisticMessage(null);
    }
  };

  const anyParticipantRunning = participants.some(p => p.running);
  const isAnyRunning = task?.status === 'working' || anyParticipantRunning;

  // Load workspace voice settings for task workspace and any advisor participants
  useEffect(() => {
    if (!task?.workspace_id) return;
    const wsIds = [task.workspace_id, ...participants.map(p => p.workspace_id)];
    for (const id of wsIds) {
      if (id in wsVoiceSettings) continue;
      getWorkspaceVoiceSettings(id)
        .then(({ voiceIds, defaultVoiceId }) => {
          setWsVoiceSettings(prev => ({ ...prev, [id]: voiceIds }));
          setWsDefaultVoices(prev => ({ ...prev, [id]: defaultVoiceId }));
        })
        .catch(() => setWsVoiceSettings(prev => ({ ...prev, [id]: [] })));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.workspace_id, participants.length]);

  // Warm the self-hosted Qwen model when voice features turn on, so the first
  // spoken reply isn't delayed by an on-demand model load on the GPU box.
  useEffect(() => {
    if (voiceModeActive || conversationMode) warmupQwen();
  }, [voiceModeActive, conversationMode, warmupQwen]);

  // Auto-speak last assistant message and/or auto-re-listen when agent finishes
  useEffect(() => {
    const wasRunning = prevIsAnyRunningRef.current;
    prevIsAnyRunningRef.current = isAnyRunning;
    if (!wasRunning || isAnyRunning) return;
    const willAutoSpeak = conversationMode && ttsVoices.length > 0;
    if (voiceModeActive && !isListening && !willAutoSpeak) {
      playListenChime();
      startListening();
    }
    if (willAutoSpeak) {
      const lastAssistant = [...messagesRef.current].reverse().find(m => m.role === 'assistant');
      if (lastAssistant && lastAssistant.id !== lastAutoSpokenMsgIdRef.current) {
        lastAutoSpokenMsgIdRef.current = lastAssistant.id;
        const wsId = lastAssistant.participant_id
          ? (participantsRef.current.find(p => p.id === lastAssistant.participant_id)?.workspace_id ?? task?.workspace_id ?? '')
          : (task?.workspace_id ?? '');
        const explicit = wsVoiceSettingsRef.current[wsId] ?? [];
        const def = wsDefaultVoicesRef.current[wsId];
        const voiceIds = def && !explicit.includes(def) ? [...explicit, def] : explicit;
        ttsSpeakAs(lastAssistant.content, lastAssistant.id, voiceIds);
      }
    }
  }, [isAnyRunning, voiceModeActive, isListening, startListening, conversationMode, ttsVoices.length, ttsSpeakAs, task?.workspace_id]);

  // After TTS finishes in conversation mode, resume listening for next user input
  useEffect(() => {
    const prev = prevTtsSpeakingIdRef.current;
    prevTtsSpeakingIdRef.current = ttsSpeakingId;
    if (prev !== null && ttsSpeakingId === null && conversationMode && voiceModeActive && !isListening) {
      playListenChime();
      startListening();
    }
  }, [ttsSpeakingId, conversationMode, voiceModeActive, isListening, startListening]);

  // Auto-send transcribed text when in conversation mode (stays in modal)
  useEffect(() => {
    if (voicePendingSendRef.current && reply.trim() && task?.status === 'awaiting_feedback') {
      voicePendingSendRef.current = false;
      replyAndStay();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply, task?.status]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) closeModal();
  };

  // Renders a reviewer turn as a compact pass/fail summary instead of the full
  // verbose review prose. On pass it's a single line; on fail it lists the
  // actionable issues and offers an "Apply suggested fixes" button. The raw
  // reviewer output is available behind a "details" toggle.
  const renderReviewerCard = (turn: TaskTurn, fullReview: string) => {
    const expanded = expandedReviews.has(turn.id);
    const issues = parseIssues(turn);

    // The verdict (review_outcome) stays null until the turn completes, but the
    // reviewer's messages persist live mid-run — so while it's still reviewing,
    // show a neutral "Reviewing…" state rather than a premature pass/fail card.
    if (turn.review_outcome == null) {
      return (
        <div className="flex items-center gap-2 py-1">
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
          <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800">
            <span className="animate-spin h-3 w-3 border-2 border-purple-600 dark:border-purple-400 border-t-transparent rounded-full" />
            Reviewing…
          </span>
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
        </div>
      );
    }

    if (turn.review_outcome === 'pass') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 py-1">
            <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
            <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              Review passed
            </span>
            {fullReview && (
              <button
                onClick={() => toggleReviewDetails(turn.id)}
                className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline"
              >
                {expanded ? 'Hide details' : 'Details'}
              </button>
            )}
            <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
          </div>
          {expanded && fullReview && (
            <div className="rounded-lg p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 mr-8">
              <Markdown content={fullReview} />
            </div>
          )}
        </div>
      );
    }

    // Fail (or a missing/garbled verdict, which the server records as a fail).
    // Only the latest reviewer turn can apply fixes — earlier failed turns are
    // superseded and their issues are stale.
    const latestReviewerTurnId = turns.reduce<TaskTurn | null>(
      (acc, t) => (t.role === 'reviewer' && (!acc || t.turn_number > acc.turn_number) ? t : acc),
      null,
    )?.id ?? null;
    const canApply = task?.status === 'awaiting_feedback' && turn.id === latestReviewerTurnId;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 py-1">
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
          <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
            Review found issues
          </span>
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
        </div>
        <div className="rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 mr-8">
          {issues.length > 0 ? (
            <ul className="list-disc list-outside ml-4 space-y-1 text-sm text-amber-900 dark:text-amber-200">
              {issues.map((iss, i) => <li key={i}>{iss}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-amber-900 dark:text-amber-200">{turn.review_summary || 'The reviewer reported issues.'}</p>
          )}
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            {canApply && (
              <button
                onClick={() => handleApplyFixes(turn)}
                disabled={applyingFixes || sending}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
              >
                {applyingFixes ? 'Applying…' : 'Apply suggested fixes'}
              </button>
            )}
            {fullReview && (
              <button
                onClick={() => toggleReviewDetails(turn.id)}
                className="text-[11px] text-amber-700/70 dark:text-amber-300/70 hover:text-amber-800 dark:hover:text-amber-200 underline"
              >
                {expanded ? 'Hide full review' : 'Show full review'}
              </button>
            )}
          </div>
          {expanded && fullReview && (
            <div className="mt-3 pt-3 border-t border-amber-200 dark:border-amber-800">
              <Markdown content={fullReview} />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4"
    >
      <div className={`flex items-stretch gap-3 w-full h-full sm:h-auto ${preview.previewEffective ? '' : 'max-w-3xl'} max-h-full sm:max-h-[90vh]`}>
      <div className="bg-white dark:bg-gray-950 rounded-none sm:rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-3xl shrink-0 h-full sm:h-auto max-h-full sm:max-h-[90vh] flex flex-col">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading task...</div>
        ) : !task ? (
          <div className="p-8 text-center text-red-600 dark:text-red-400">Task not found</div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-200 dark:border-gray-800">
              <div className="flex-1 min-w-0">
                {editingTitle ? (
                  <input
                    ref={titleInputRef}
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={saveTitle}
                    disabled={savingTitle}
                    maxLength={200}
                    className="w-full text-lg font-semibold text-gray-900 dark:text-gray-100 bg-transparent border border-blue-400 dark:border-blue-500 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                    aria-label="Task title"
                  />
                ) : (
                  <h2
                    className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate cursor-text rounded px-2 py-0.5 -mx-2 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-colors"
                    onClick={startEditTitle}
                    title="Click to edit title"
                  >
                    {task.title}
                  </h2>
                )}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[task.status] || ''}`}>
                    {task.status.replace('_', ' ')}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">{task.workspace_name}</span>
                  {task.model && (
                    <span className={`hidden sm:inline-block text-xs px-1.5 py-0.5 rounded font-medium ${
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
                    className="hidden sm:inline-block text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 font-mono transition-colors"
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
                      className="hidden sm:inline-block text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono"
                      title={`Input: ${task.total_input_tokens.toLocaleString()} | Output: ${task.total_output_tokens.toLocaleString()}`}
                    >
                      {formatTokens(task.total_input_tokens + task.total_output_tokens)} tokens
                    </span>
                  )}
                  {typeof task.total_cost_usd === 'number' && task.total_cost_usd > 0 && (
                    <span className="hidden sm:inline-block text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono">
                      ${task.total_cost_usd.toFixed(2)}
                    </span>
                  )}
                  {task.git_branch && (
                    task.github_repo_url ? (
                      <a
                        href={task.git_provider === 'azure'
                          ? `${task.github_repo_url}?version=GB${encodeURIComponent(task.git_branch)}`
                          : `${task.github_repo_url}/tree/${task.git_branch}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hidden sm:inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors font-mono"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path fillRule="evenodd" d="M11.75 2.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-8.5 0a.75.75 0 0 1 .75.75v3.402c.458-.204.96-.319 1.489-.319A4.265 4.265 0 0 1 9.49 9.39V3.25a.75.75 0 0 1 1.5 0v7.5a.75.75 0 0 1-1.5 0v-.156a2.765 2.765 0 0 0-3.999-2.473A2.766 2.766 0 0 0 4 10.75v.001a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.751Z" clipRule="evenodd" /></svg>
                        {task.git_branch}
                      </a>
                    ) : (
                      <span className="hidden sm:inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path fillRule="evenodd" d="M11.75 2.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-8.5 0a.75.75 0 0 1 .75.75v3.402c.458-.204.96-.319 1.489-.319A4.265 4.265 0 0 1 9.49 9.39V3.25a.75.75 0 0 1 1.5 0v7.5a.75.75 0 0 1-1.5 0v-.156a2.765 2.765 0 0 0-3.999-2.473A2.766 2.766 0 0 0 4 10.75v.001a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.751Z" clipRule="evenodd" /></svg>
                        {task.git_branch}
                      </span>
                    )
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
              <PreviewToggleButton state={preview} />
              {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'awaiting_feedback') && (
                <button
                  onClick={handleDelete}
                  className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 p-1"
                  title="Delete task"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
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
              {(() => {
                const turnMap = new Map(turns.map(t => [t.id, t]));
                // Concatenate each reviewer turn's prose so it can be revealed
                // behind the per-turn "details" toggle on its summary card.
                const reviewerContentByTurn = new Map<string, string>();
                for (const m of messages) {
                  if (m.role === 'assistant' && m.turn_id && turnMap.get(m.turn_id)?.role === 'reviewer') {
                    const prev = reviewerContentByTurn.get(m.turn_id);
                    reviewerContentByTurn.set(m.turn_id, prev ? `${prev}\n\n${m.content}` : m.content);
                  }
                }
                let lastTurnId: string | null | undefined = undefined;
                return messages.map((msg) => {
                  const isParticipantMsg = msg.role === 'assistant' && msg.participant_id;
                  const participantName = msg.participant_id
                    ? participants.find(p => p.id === msg.participant_id)?.workspace_name
                    : null;
                  const recipientLabel = msg.role === 'user' && msg.participant_id && participants.length > 0
                    ? participants.find(p => p.id === msg.participant_id)?.workspace_name
                    : null;

                  const turnChanged = msg.turn_id !== undefined && msg.turn_id !== lastTurnId;
                  if (turnChanged) lastTurnId = msg.turn_id;
                  const turn = msg.turn_id ? turnMap.get(msg.turn_id) : undefined;
                  const isReviewerMsg = turn?.role === 'reviewer';

                  // Reviewer turns collapse into a single compact summary card
                  // (rendered once, at the turn boundary). Skip the verbose
                  // per-message bubbles entirely.
                  if (isReviewerMsg && turn) {
                    if (!turnChanged) return null;
                    return (
                      <React.Fragment key={msg.id}>
                        {renderReviewerCard(turn, reviewerContentByTurn.get(turn.id) || '')}
                      </React.Fragment>
                    );
                  }

                  return (
                    <React.Fragment key={msg.id}>
                      {turnChanged && turn && (
                        <div className="flex items-center gap-2 py-1">
                          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                          <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>
                            Implementer{turn.turn_number > 1 ? ` · Turn ${Math.ceil(turn.turn_number / 2)}` : ''}
                          </span>
                          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                        </div>
                      )}
                  <div
                    className={`rounded-lg p-4 ${
                      msg.role === 'user'
                        ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 ml-8'
                        : msg.role === 'assistant' && isParticipantMsg
                        ? 'bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800 mr-8'
                        : msg.role === 'assistant' && isReviewerMsg
                        ? 'bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 mr-8'
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
                        {msg.source === 'api' && (
                          <span
                            title={`Originated via API${msg.client_label ? ` (${msg.client_label})` : ''}`}
                            className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium normal-case bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800"
                          >
                            via {msg.client_label || 'API'}
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {msg.cost && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">${msg.cost.toFixed(4)}</span>
                        )}
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {new Date(msg.created_at).toLocaleTimeString()}
                        </span>
                        {msg.role === 'assistant' && ttsVoices.length > 0 && (
                          <button
                            onClick={() => {
                              const wsId = msg.participant_id
                                ? (participants.find(p => p.id === msg.participant_id)?.workspace_id ?? task?.workspace_id ?? '')
                                : (task?.workspace_id ?? '');
                              if (ttsSpeakingId === msg.id) { ttsStop(); return; }
                              const explicit = wsVoiceSettings[wsId] ?? [];
                              const def = wsDefaultVoices[wsId];
                              const voiceIds = def && !explicit.includes(def) ? [...explicit, def] : explicit;
                              ttsSpeakAs(msg.content, msg.id, voiceIds);
                            }}
                            className={`p-0.5 rounded transition-colors ${ttsSpeakingId === msg.id ? 'text-purple-600 dark:text-purple-400' : 'text-gray-300 dark:text-gray-600 hover:text-purple-500 dark:hover:text-purple-400'}`}
                            title={ttsSpeakingId === msg.id ? 'Stop' : 'Read aloud'}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                    <Markdown content={msg.content} breaks={msg.role === 'user'} />
                  </div>
                    </React.Fragment>
                  );
                });
              })()}

              {optimisticMessage && (
                <div className="rounded-lg p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 ml-8 opacity-70">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                      user
                      {optimisticMessage.participant_id && (
                        <span className="ml-1 normal-case font-normal opacity-70">
                          → {participants.find(p => p.id === optimisticMessage.participant_id)?.workspace_name || 'advisor'}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {new Date(optimisticMessage.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <Markdown content={optimisticMessage.content} breaks />
                </div>
              )}

              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-1">
                  {attachments.map(att => (
                    <a
                      key={att.id}
                      href={`/api/uploads/${att.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      title={`${att.original_name} (${(att.size / 1024).toFixed(1)} KB)`}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                      {att.original_name}
                    </a>
                  ))}
                </div>
              )}

              {(task.status === 'working' || (sending && !targetParticipantId)) && (
                <div className={`text-sm p-4 rounded-lg border ${
                  task.active_turn_role === 'reviewer'
                    ? 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800'
                    : 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800'
                }`}>
                  <div className="flex items-center gap-2">
                    <div className={`animate-spin h-4 w-4 border-2 border-t-transparent rounded-full ${
                      task.active_turn_role === 'reviewer'
                        ? 'border-purple-600 dark:border-purple-400'
                        : 'border-blue-600 dark:border-blue-400'
                    }`} />
                    <span>{
                      task.active_turn_role === 'reviewer'
                        ? 'Reviewer is checking the work...'
                        : task.status === 'working'
                        ? 'Claude is working...'
                        : 'Sending message...'
                    }</span>
                    {task.status === 'working' && task.activity && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                        Last activity {timeAgo(task.activity.timestamp)}
                      </span>
                    )}
                  </div>
                  {task.status === 'working' && task.activity && (
                    <p className={`mt-1 text-xs truncate ml-6 ${
                      task.active_turn_role === 'reviewer'
                        ? 'text-purple-500 dark:text-purple-300'
                        : 'text-blue-500 dark:text-blue-300'
                    }`}>
                      {linkify(task.activity.summary)}
                    </p>
                  )}
                </div>
              )}

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

              {/* Sending-to-participant transient indicator (before polling picks up running state) */}
              {sending && targetParticipantId && !participants.find(p => p.id === targetParticipantId)?.running && (
                <div className="text-sm text-teal-600 dark:text-teal-400 p-4 bg-teal-50 dark:bg-teal-900/20 rounded-lg border border-teal-100 dark:border-teal-800">
                  <div className="flex items-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-teal-600 dark:border-teal-400 border-t-transparent rounded-full" />
                    <span>Sending message...</span>
                  </div>
                </div>
              )}

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

              {/* Pending task requests (delegated work proposed by the agent) */}
              {taskRequests.map((tr) => {
                const hostId = task.workspace_id;
                const selectedTargetId = requestTargetOverride[tr.id] ?? tr.target_workspace_id ?? hostId;
                const isCrossWorkspace = selectedTargetId !== hostId;
                const selectedWorkspace = allRunningWorkspaces?.find(w => w.id === selectedTargetId);
                const selectedTargetName = isCrossWorkspace
                  ? (selectedWorkspace?.name ?? tr.target_workspace_name ?? 'unknown')
                  : task.workspace_name;
                const cardClass = isCrossWorkspace
                  ? 'rounded-lg p-4 bg-rose-50 dark:bg-rose-900/20 border-2 border-rose-300 dark:border-rose-700'
                  : 'rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800';
                const labelClass = isCrossWorkspace
                  ? 'text-xs font-semibold text-rose-700 dark:text-rose-400 uppercase'
                  : 'text-xs font-medium text-amber-700 dark:text-amber-400 uppercase';
                const createBtnClass = isCrossWorkspace
                  ? 'text-xs px-3 py-1.5 bg-rose-600 text-white rounded hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed'
                  : 'text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed';
                return (
                  <div key={tr.id} className={cardClass}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={labelClass}>
                        {isCrossWorkspace ? 'Proposed Task — Cross-Workspace' : 'Proposed Task'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap mb-3">{tr.prompt}</p>
                    <div className="flex items-center gap-2 mb-3 text-xs text-gray-700 dark:text-gray-300">
                      <label htmlFor={`task-target-${tr.id}`}>Run in:</label>
                      <select
                        id={`task-target-${tr.id}`}
                        value={selectedTargetId}
                        onChange={(e) => handleChangeRequestTarget(tr.id, e.target.value)}
                        disabled={processingRequest !== null}
                        className="text-xs px-2 py-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded disabled:opacity-50"
                      >
                        <option value={hostId}>{task.workspace_name} (this workspace)</option>
                        {(allRunningWorkspaces ?? [])
                          .filter(ws => ws.id !== hostId)
                          .map(ws => (
                            <option key={ws.id} value={ws.id}>{ws.name}</option>
                          ))}
                        {tr.target_workspace_id && tr.target_workspace_id !== hostId &&
                          !(allRunningWorkspaces ?? []).some(ws => ws.id === tr.target_workspace_id) && (
                            <option value={tr.target_workspace_id}>{tr.target_workspace_name ?? 'unknown'}</option>
                          )}
                      </select>
                    </div>
                    {isCrossWorkspace && (
                      <p className="text-xs text-rose-700 dark:text-rose-300 mb-3">
                        ⚠ This task will be queued in <strong>{selectedTargetName}</strong>, not in this task's workspace. You'll be asked to confirm.
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApproveRequest(tr.id, isCrossWorkspace ? selectedTargetId : null, selectedTargetName)}
                        disabled={processingRequest !== null}
                        className={createBtnClass}
                      >
                        {processingRequest === tr.id
                          ? 'Creating...'
                          : isCrossWorkspace ? `Create in ${selectedTargetName}` : 'Create Task'}
                      </button>
                      <button
                        onClick={() => handleDismissRequest(tr.id)}
                        disabled={processingRequest !== null}
                        className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {processingRequest === tr.id ? 'Dismissing...' : 'Dismiss'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Actions footer */}
            <div className="border-t border-gray-200 dark:border-gray-800 p-5">
              {resetSessionOpen && (
                <div className="mb-3 space-y-2 border border-gray-200 dark:border-gray-700 rounded-md p-3 bg-gray-50 dark:bg-gray-800/50">
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    Type a continuation message. The agent will start with a clean context
                    and only see this message — refer to file paths or summarize what's needed.
                  </div>
                  <textarea
                    value={resetSessionPrompt}
                    onChange={(e) => setResetSessionPrompt(e.target.value)}
                    placeholder="e.g. Continue where we left off. The current code is on disk at <path>."
                    className="w-full text-sm p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    rows={4}
                    autoFocus
                    disabled={resettingSession}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleResetSession}
                      disabled={!resetSessionPrompt.trim() || resettingSession}
                      className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {resettingSession ? 'Starting...' : 'Start fresh session'}
                    </button>
                    <button
                      onClick={() => { setResetSessionOpen(false); setResetSessionPrompt(''); }}
                      disabled={resettingSession}
                      className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-2"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {task.status === 'awaiting_feedback' && (
                <div className="space-y-3">
                  {!!task.pending_complete && (
                    <div className="text-xs px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                      Completion is queued — will finalize once the working task on this workspace finishes. Replying below will cancel the pending completion.
                    </div>
                  )}
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
                            onClick={() => handleParticipantCatchUp(p.id)}
                            disabled={p.running}
                            className="text-xs px-1.5 py-1 border-y border-gray-200 dark:border-gray-700 text-gray-400 hover:text-teal-500 hover:border-teal-300 dark:hover:border-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title={`Catch ${p.workspace_name} up on the conversation`}
                          >
                            &#8635;
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
                      {/* @-mention trigger — tappable fallback for mobile where the
                          textarea may not fire onChange cleanly for the @ key. */}
                      <button
                        type="button"
                        onClick={openMentionMenu}
                        title="Mention an agent"
                        className="text-xs px-2 py-1 rounded-full border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-teal-400 hover:text-teal-600 dark:hover:border-teal-600 dark:hover:text-teal-400 transition-colors"
                      >
                        @ Mention
                      </button>
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
                      <div className="relative">
                        <textarea
                          ref={replyTextareaRef}
                          value={reply}
                          onChange={handleReplyChange}
                          onKeyDown={handleParticipantReplyKeyDown}
                          onSelect={handleReplySelect}
                          onCompositionStart={() => { isComposingRef.current = true; }}
                          onCompositionEnd={handleReplyCompositionEnd}
                          placeholder={anyParticipantRunning
                            ? 'Advisor is thinking...'
                            : `${`Ask ${participants.find(p => p.id === targetParticipantId)?.workspace_name || 'advisor'}...`}${participants.length > 0 ? ' (type @ to mention)' : ''}`}
                          rows={3}
                          autoFocus
                          disabled={sending || anyParticipantRunning}
                          className="w-full px-3 py-2 border border-teal-300 dark:border-teal-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-y disabled:opacity-50 sm:min-h-[11rem]"
                        />
                        {mentionDropdown}
                      </div>
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
                      <div className="relative">
                        <textarea
                          ref={replyTextareaRef}
                          value={reply}
                          onChange={handleReplyChange}
                          onKeyDown={handleReplyKeyDown}
                          onSelect={handleReplySelect}
                          onCompositionStart={() => { isComposingRef.current = true; }}
                          onCompositionEnd={handleReplyCompositionEnd}
                          placeholder={anyParticipantRunning
                            ? 'Advisor is thinking...'
                            : participants.length > 0
                              ? 'Reply with feedback... (type @ to mention)'
                              : 'Reply with feedback...'}
                          rows={3}
                          autoFocus
                          disabled={anyParticipantRunning}
                          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y disabled:opacity-50 sm:min-h-[11rem]"
                        />
                        {mentionDropdown}
                      </div>
                      {pendingFiles.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {pendingFiles.map((f, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                              {f.name}
                              <button type="button" onClick={() => handleRemovePendingFile(i)} className="ml-0.5 text-blue-400 hover:text-red-500">&times;</button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => handleFileSelect(e.target.files)}
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploading || anyParticipantRunning}
                          className="p-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-600 transition-colors disabled:opacity-50"
                          title="Attach files"
                        >
                          {uploading ? (
                            <div className="w-5 h-5 border border-current border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                          )}
                        </button>
                        <div className="flex-1" />
                        {/* Voice controls */}
                        {kokoroLoading && (
                          <span className="text-[10px] text-purple-500 dark:text-purple-400 whitespace-nowrap animate-pulse">
                            {kokoroProgress > 0 && kokoroProgress < 100 ? `Kokoro ${kokoroProgress}%` : 'Loading Kokoro…'}
                          </span>
                        )}
                        {voiceDebug && (
                          <span className={`hidden sm:inline-block text-xs truncate max-w-[180px] ${
                            isTranscribing ? 'text-amber-500 dark:text-amber-400 animate-pulse'
                            : isListening ? 'text-purple-500 dark:text-purple-400 animate-pulse'
                            : 'text-gray-400 dark:text-gray-500'
                          }`} title={voiceDebug}>{voiceDebug}</span>
                        )}
                        {voiceSupported && ttsVoices.length > 0 && (
                          <button
                            type="button"
                            onClick={toggleConversationMode}
                            className={`p-2 rounded-md transition-colors ${conversationMode ? 'text-white bg-purple-600 hover:bg-purple-700' : 'text-gray-400 dark:text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20'}`}
                            title={conversationMode ? 'Conversation mode on — auto-reads replies, auto-sends speech' : 'Enable conversation mode'}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                            </svg>
                          </button>
                        )}
                        {voiceSupported && (
                          <button
                            type="button"
                            onClick={() => {
                              if (isTranscribing) return;
                              if (isListening) {
                                stopListening();
                                if (!useWhisper) setVoiceModeActive(false);
                              } else {
                                setVoiceModeActive(true);
                                playListenChime();
                                startListening();
                              }
                            }}
                            disabled={sending || isAnyRunning || isTranscribing}
                            className={`relative p-2 rounded-md transition-colors disabled:opacity-50 ${
                              isTranscribing ? 'text-amber-600 bg-amber-100 dark:bg-amber-900/30'
                              : isListening ? 'text-white bg-purple-600 voice-pulse-ring'
                              : voiceModeActive ? 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30 hover:bg-purple-200 dark:hover:bg-purple-900/50'
                              : 'text-gray-400 dark:text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20'
                            }`}
                            title={isTranscribing ? 'Transcribing...' : isListening ? 'Stop recording' : useWhisper ? 'Push to talk' : voiceModeActive ? 'Resume listening' : 'Start voice mode'}
                          >
                            {isTranscribing ? (
                              <div className="h-5 w-5 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
                              </svg>
                            )}
                          </button>
                        )}
                        <button
                          type="submit"
                          disabled={sending || (!reply.trim() && uploadedAttachmentIds.length === 0) || anyParticipantRunning}
                          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
                        >
                          {sending ? 'Sending...' : 'Reply (Ctrl+Enter)'}
                        </button>
                      </div>
                    </form>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleComplete}
                      disabled={completing || !!task.pending_complete}
                      className="bg-green-600 text-white text-sm px-4 py-2 rounded-md hover:bg-green-700 disabled:opacity-50"
                      title={task.pending_complete ? 'Completion queued — will finalize once the working task finishes' : undefined}
                    >
                      {task.pending_complete ? 'Completion queued…' : completing ? 'Completing...' : (
                        <>Complete<span className="hidden sm:inline"> (Alt+C)</span></>
                      )}
                    </button>
                    {/* Session maintenance — rarely used, tucked into a dropdown */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setSessionMenuOpen(o => !o)}
                        className="inline-flex items-center gap-1 text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
                        title="Session maintenance"
                      >
                        Session
                        <svg className={`w-3 h-3 transition-transform ${sessionMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                      </button>
                      {sessionMenuOpen && (
                        <div className="absolute bottom-full left-0 mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 min-w-[180px] overflow-hidden">
                          <button
                            onClick={() => { setSessionMenuOpen(false); handleCompactSession(); }}
                            disabled={compactingSession}
                            className="w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 disabled:opacity-50 border-b border-gray-100 dark:border-gray-800"
                            title="Ask Claude Code to summarize prior turns and free up context — preserves the session"
                          >
                            {compactingSession ? 'Compacting…' : 'Compact session'}
                          </button>
                          <button
                            onClick={() => { setSessionMenuOpen(false); setResetSessionOpen(o => !o); }}
                            className="w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
                            title="Start a fresh Claude session for this task — drops in-session memory but keeps the task and its prior messages"
                          >
                            Reset session
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Invite advisor (icon) when no participants yet */}
                    {participants.length === 0 && (
                      <div className="relative">
                        <button
                          onClick={handleOpenInviteMenu}
                          className="p-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 hover:border-green-300 dark:hover:border-green-600 transition-colors"
                          title="Invite an advisor"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" /></svg>
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
                      autoRetry
                    />
                  ) : task.failed_reason?.startsWith('context_window_exceeded:') ? (
                    <div className="space-y-2">
                      <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 p-3 rounded-md">
                        <div className="font-medium mb-1">Session too large to continue</div>
                        <div className="text-xs">
                          This task's Claude session has grown past the model's context window
                          ({task.failed_reason.slice('context_window_exceeded:'.length).trim()}).
                          Compacting will ask Claude Code to summarize prior turns so the session
                          can continue. Starting fresh discards in-session memory entirely.
                        </div>
                      </div>
                      {!resetSessionOpen ? (
                        <div className="flex gap-2">
                          <button
                            onClick={handleCompactSession}
                            disabled={compactingSession}
                            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
                          >
                            {compactingSession ? 'Compacting...' : 'Compact session'}
                          </button>
                          <button
                            onClick={() => setResetSessionOpen(true)}
                            className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-2"
                          >
                            Start fresh session
                          </button>
                          <button
                            onClick={handleRetry}
                            className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-2"
                          >
                            Retry anyway
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      {task.failed_reason && (
                        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-md">
                          {task.failed_reason}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={handleRetry}
                          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700"
                        >
                          Retry
                        </button>
                        <button
                          onClick={handleCompactSession}
                          disabled={compactingSession}
                          className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-2 disabled:opacity-50"
                          title="Ask Claude Code to summarize prior turns and free up context — preserves the session"
                        >
                          {compactingSession ? 'Compacting...' : 'Compact session'}
                        </button>
                        {!resetSessionOpen && (
                          <button
                            onClick={() => setResetSessionOpen(true)}
                            className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-2"
                            title="Start a fresh Claude session — discards in-session memory but keeps the task and its prior messages"
                          >
                            Start fresh session
                          </button>
                        )}
                      </div>
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
                <div className="space-y-2">
                  <div className="text-xs px-3 py-2 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
                    Queued — waiting for the active task on this workspace to finish.
                  </div>
                  <button
                    onClick={handleCancel}
                    className="text-sm text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                  >
                    Cancel Task
                  </button>
                </div>
              )}

            </div>
          </>
        )}
      </div>
      {preview.previewEffective && task && <WorkspacePreviewPanel state={preview} />}
      </div>
    </div>
  );
}
