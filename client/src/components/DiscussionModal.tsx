import { useState, useEffect, useRef, useMemo, useCallback, memo, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
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
  updateTaskRequestTarget,
  addDiscussionParticipant,
  removeDiscussionParticipant,
  sendParticipantMessage,
  getWorkspaces,
  getWorkspaceVoiceSettings,
  touchDiscussion,
  type Discussion,
  type DiscussionMessage,
  type DiscussionParticipant,
  type TaskRequestItem,
  type Workspace,
} from '../api/client';
import { useDraft } from '../hooks/useDraft';
import { useWorkspacePreview } from '../hooks/useWorkspacePreview';
import WorkspacePreviewPanel, { PreviewToggleButton } from './WorkspacePreviewPanel';
import { useTTSVoice } from '../hooks/useTTSVoice';
import { useVoiceMode } from '../hooks/useVoiceMode';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { linkify } from '../utils/linkify';
import { playListenChime } from '../utils/listenChime';
import Markdown from './Markdown';
import RateLimitBanner from './RateLimitBanner';

const TASK_REQUEST_RE = /\[TASK_REQUEST\]\s*[\s\S]*?\s*\[\/TASK_REQUEST\]/g;
const MENTION_RE = /\[MENTION:[^\]]+\]/g;

function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}

interface MessageRowProps {
  msg: DiscussionMessage;
  hostWorkspaceName?: string;
  participants?: DiscussionParticipant[];
  onSpeak?: (text: string, msgId: string) => void;
  isSpeaking?: boolean;
}

const MessageRow = memo(function MessageRow({ msg, hostWorkspaceName, participants, onSpeak, isSpeaking }: MessageRowProps) {
  const strippedContent = msg.role === 'assistant'
    ? msg.content.replace(TASK_REQUEST_RE, '').replace(MENTION_RE, '').trim()
    : msg.content;

  const handleSpeak = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!onSpeak) return;
    const text = stripMarkdownForSpeech(strippedContent);
    if (!text) return;
    onSpeak(text, msg.id);
  };

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
          {msg.role === 'assistant' && onSpeak && (
            <button
              onClick={handleSpeak}
              className={`p-0.5 rounded transition-colors ${
                isSpeaking
                  ? 'text-purple-500 dark:text-purple-400'
                  : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'
              }`}
              title={isSpeaking ? 'Stop speaking' : 'Read aloud'}
            >
              {isSpeaking ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          )}
          {msg.cost && (
            <span className="text-xs text-gray-400 dark:text-gray-500">${msg.cost.toFixed(4)}</span>
          )}
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {new Date(msg.created_at).toLocaleTimeString()}
          </span>
        </div>
      </div>
      <Markdown content={msg.role === 'assistant' ? strippedContent : msg.content} breaks={msg.role === 'user'} />
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
  const [optimisticMessage, setOptimisticMessage] = useState<DiscussionMessage | null>(null);
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

  // @-mention autocomplete state. anchorStart is the index of the '@' in the
  // textarea value; query is the text typed after it.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const [mentionMenu, setMentionMenu] = useState<{
    open: boolean;
    anchorStart: number;
    query: string;
    selectedIndex: number;
  }>({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });

  // Per-request target override (lets user change destination before approving).
  // Keyed by task_request id; absent key means "use whatever's stored on the request".
  const [requestTargetOverride, setRequestTargetOverride] = useState<Record<string, string>>({});
  const [allRunningWorkspaces, setAllRunningWorkspaces] = useState<Workspace[] | null>(null);

  const preview = useWorkspacePreview(workspaceId, discussionId);

  // Voice mode state
  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const prevDiscRunningRef = useRef(false);
  const prevParticipantRunningRef = useRef<Map<string, boolean>>(new Map());
  const ttsSpeakingIdRef = useRef<string | null>(null);
  const voicePendingSendRef = useRef(false);

  // Conversation mode: auto-reads incoming messages + auto-sends on PTT release
  const [conversationMode, setConversationMode] = useState(() => localStorage.getItem('voice:conversation') === '1');
  const conversationModeRef = useRef(conversationMode);
  conversationModeRef.current = conversationMode;
  const lastAutoSpokenMsgIdRef = useRef<string | null>(null);
  const prevTtsSpeakingIdRef = useRef<string | null>(null);
  const ttsSpeakQueueRef = useRef<Array<{ content: string; id: string; voiceIds: string[] }>>([]);

  // Play-on-open: speak new messages when modal is opened in conversation mode
  const [touchResult, setTouchResult] = useState<{ previousOpenedAt: string | null } | null>(null);
  const playOnOpenDoneRef = useRef(false);

  const toggleConversationMode = useCallback(() => {
    setConversationMode(v => {
      const next = !v;
      localStorage.setItem('voice:conversation', next ? '1' : '0');
      return next;
    });
  }, []);

  const handleVoiceTranscript = useCallback((text: string) => {
    setMessage(text);
  }, [setMessage]);

  const handleVoiceSilence = useCallback((finalText: string) => {
    setMessage(finalText);
    if (conversationModeRef.current) voicePendingSendRef.current = true;
  }, [setMessage]);

  // Whisper-based push-to-talk (preferred when available)
  const handleRecorderTranscript = useCallback((text: string) => {
    setMessage(text);
    if (conversationModeRef.current) voicePendingSendRef.current = true;
  }, [setMessage]);

  const recorder = useVoiceRecorder({
    onTranscript: handleRecorderTranscript,
  });

  // SpeechRecognition fallback (Chrome/Edge only)
  const speechRec = useVoiceMode({
    onTranscript: handleVoiceTranscript,
    onSilenceTimeout: handleVoiceSilence,
  });

  // Prefer Whisper recorder if available; fall back to SpeechRecognition
  const useWhisper = recorder.isSupported;
  const voiceSupported = useWhisper || speechRec.isSupported;
  const isListening = useWhisper ? recorder.isRecording : speechRec.isListening;
  const isTranscribing = useWhisper ? recorder.isTranscribing : false;
  const voiceDebug = useWhisper ? recorder.debugStatus : speechRec.debugStatus;

  const startListening = useCallback(() => {
    if (useWhisper) {
      recorder.startRecording();
    } else {
      speechRec.startListening();
    }
  }, [useWhisper, recorder.startRecording, speechRec.startListening]);

  const stopListening = useCallback(() => {
    if (useWhisper) {
      recorder.stopRecording();
    } else {
      speechRec.stopListening();
    }
  }, [useWhisper, recorder.stopRecording, speechRec.stopListening]);

  const { voices: ttsVoices, speak: ttsSpeak, speakAs: ttsSpeakAs, stopSpeaking: ttsStop, speakingId: ttsSpeakingId, kokoroLoading, kokoroProgress, kokoroError } = useTTSVoice();
  ttsSpeakingIdRef.current = ttsSpeakingId;

  // Voice settings keyed by workspace ID — loaded lazily when participants join
  const [wsVoiceSettings, setWsVoiceSettings] = useState<Record<string, string[]>>({});
  const wsVoiceSettingsRef = useRef(wsVoiceSettings);
  wsVoiceSettingsRef.current = wsVoiceSettings;
  const [wsDefaultVoices, setWsDefaultVoices] = useState<Record<string, string | null>>({});
  const wsDefaultVoicesRef = useRef(wsDefaultVoices);
  wsDefaultVoicesRef.current = wsDefaultVoices;

  // Resolve workspace ID for a message (null participant_id = host workspace)
  const getMsgWorkspaceId = useCallback((msg: DiscussionMessage): string => {
    if (!msg.participant_id) return workspaceId;
    return participants.find(p => p.id === msg.participant_id)?.workspace_id ?? workspaceId;
  }, [workspaceId, participants]);

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
        // Incremental — append only messages not already in state (guards against concurrent loadData calls)
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const fresh = data.messages.filter(m => !existingIds.has(m.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
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
  }, [loading, messages.length, optimisticMessage?.id]);

  // Clear the optimistic message as soon as a matching real message appears in
  // the list (either via the explicit reload after send, or via a polling tick
  // that races the API response). Otherwise the optimistic stays mounted for
  // the full duration of the in-flight send and shows as a duplicate.
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

  // Browser back button
  useEffect(() => {
    window.history.pushState({ modal: 'discussion' }, '');
    const handlePopState = () => { onClose(); };
    window.addEventListener('popstate', handlePopState);
    return () => { window.removeEventListener('popstate', handlePopState); };
  }, []);

  // Touch the discussion on mount to record open time and get previous open time
  useEffect(() => {
    touchDiscussion(discussionId)
      .then(setTouchResult)
      .catch(() => setTouchResult({ previousOpenedAt: null }));
  }, [discussionId]);

  // Play-on-open: once initial load is done, speak assistant messages newer than previousOpenedAt
  // Uses visibleMessagesRef (not state) to avoid declaring this effect after the useMemo below
  useEffect(() => {
    if (playOnOpenDoneRef.current) return;
    if (!touchResult || loading || !conversationMode || ttsVoices.length === 0) return;
    playOnOpenDoneRef.current = true;
    if (touchResult.previousOpenedAt === null) return; // first ever open — nothing to speak

    const threshold = touchResult.previousOpenedAt;
    const newMsgs = visibleMessagesRef.current.filter(
      m => m.role === 'assistant' && m.created_at > threshold
    );
    if (newMsgs.length === 0) return;

    // Mark all as spoken so the regular auto-speak effect doesn't re-queue them
    lastAutoSpokenMsgIdRef.current = newMsgs[newMsgs.length - 1].id;

    const items = newMsgs.map(m => {
      const wsId = m.participant_id
        ? (participants.find(p => p.id === m.participant_id)?.workspace_id ?? workspaceId)
        : workspaceId;
      const stripped = stripMarkdownForSpeech(
        m.content.replace(TASK_REQUEST_RE, '').replace(MENTION_RE, '').trim()
      );
      const explicit = wsVoiceSettingsRef.current[wsId] ?? [];
      const def = wsDefaultVoicesRef.current[wsId];
      const voiceIds = def && !explicit.includes(def) ? [...explicit, def] : explicit;
      return { content: stripped, id: m.id, voiceIds };
    });

    if (ttsSpeakQueueRef.current.length > 0 || ttsSpeakingIdRef.current !== null) {
      ttsSpeakQueueRef.current.push(...items);
    } else {
      ttsSpeakQueueRef.current = items.slice(1);
      ttsSpeakAs(items[0].content, items[0].id, items[0].voiceIds);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchResult, loading, conversationMode, ttsVoices.length]);

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
  const visibleMessagesRef = useRef(visibleMessages);
  visibleMessagesRef.current = visibleMessages;

  // Load voice settings for any workspace we haven't fetched yet (host + participants)
  useEffect(() => {
    const wsIds = [workspaceId, ...participants.map(p => p.workspace_id)];
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
  }, [workspaceId, participants.length]);

  // Computed: is any agent (host or participant) running?
  const isAnyRunning = !!(discussion?.running) || participants.some(p => p.running);
  const runningParticipant = participants.find(p => p.running);
  const runningAgentName = discussion?.running ? workspaceName : runningParticipant?.workspace_name || null;

  // Speak each agent's message as soon as that agent finishes, without waiting for others.
  useEffect(() => {
    if (!conversationMode || ttsVoices.length === 0) return;

    const hostJustFinished = prevDiscRunningRef.current && !discussion?.running;
    const justFinishedPIds = new Set<string>();
    for (const p of participants) {
      if (prevParticipantRunningRef.current.get(p.id) && !p.running) justFinishedPIds.add(p.id);
    }

    prevDiscRunningRef.current = !!discussion?.running;
    prevParticipantRunningRef.current = new Map(participants.map(p => [p.id, p.running]));

    if (!hostJustFinished && justFinishedPIds.size === 0) return;

    const msgs = visibleMessagesRef.current;
    const lastSpokenId = lastAutoSpokenMsgIdRef.current;
    const lastSpokenIdx = lastSpokenId !== null ? msgs.findIndex(m => m.id === lastSpokenId) : -1;

    // Candidate pool: messages after last spoken, or (bootstrap) most recent per agent
    let candidates: DiscussionMessage[];
    if (lastSpokenIdx >= 0) {
      candidates = msgs.slice(lastSpokenIdx + 1).filter(m => m.role === 'assistant');
    } else {
      // Bootstrap: only the most-recent message from each just-finished agent
      const byAgent = new Map<string | null, DiscussionMessage>();
      for (const m of msgs) {
        if (m.role !== 'assistant') continue;
        const key = m.participant_id ?? null;
        if (key === null ? hostJustFinished : justFinishedPIds.has(key)) byAgent.set(key, m);
      }
      candidates = [...byAgent.values()];
    }

    const readyToSpeak = candidates.filter(m =>
      m.participant_id ? justFinishedPIds.has(m.participant_id) : hostJustFinished
    );
    if (readyToSpeak.length === 0) return;

    lastAutoSpokenMsgIdRef.current = readyToSpeak[readyToSpeak.length - 1].id;

    const newItems = readyToSpeak.map(m => {
      const wsId = m.participant_id
        ? (participants.find(p => p.id === m.participant_id)?.workspace_id ?? workspaceId)
        : workspaceId;
      const stripped = stripMarkdownForSpeech(
        m.content.replace(TASK_REQUEST_RE, '').replace(MENTION_RE, '').trim()
      );
      const explicit = wsVoiceSettingsRef.current[wsId] ?? [];
      const def = wsDefaultVoicesRef.current[wsId];
      const voiceIds = def && !explicit.includes(def) ? [...explicit, def] : explicit;
      return { content: stripped, id: m.id, voiceIds };
    });

    if (ttsSpeakQueueRef.current.length > 0 || ttsSpeakingIdRef.current !== null) {
      // Already speaking — append so it plays after current item
      ttsSpeakQueueRef.current.push(...newItems);
    } else {
      ttsSpeakQueueRef.current = newItems.slice(1);
      ttsSpeakAs(newItems[0].content, newItems[0].id, newItems[0].voiceIds);
    }
  }, [discussion?.running, participants, conversationMode, ttsVoices.length, ttsSpeakAs, workspaceId]);

  // After TTS finishes: play next queued message (PTT handles re-listen manually)
  useEffect(() => {
    const prev = prevTtsSpeakingIdRef.current;
    prevTtsSpeakingIdRef.current = ttsSpeakingId;
    if (prev === null || ttsSpeakingId !== null || !conversationMode) return;
    const next = ttsSpeakQueueRef.current.shift();
    if (next) {
      ttsSpeakAs(next.content, next.id, next.voiceIds);
    }
  }, [ttsSpeakingId, conversationMode, ttsSpeakAs]);

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
    onClose();
  };

  // Lazy-load the running workspace list once a pending task request appears,
  // so the proposed-task card can offer a target dropdown without an extra
  // click. Refreshed only when the list of pending request ids changes.
  useEffect(() => {
    if (taskRequests.length === 0 || allRunningWorkspaces !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getWorkspaces();
        if (cancelled) return;
        setAllRunningWorkspaces(data.workspaces.filter(ws => ws.latest_build.status === 'running'));
      } catch {
        if (!cancelled) setAllRunningWorkspaces([]);
      }
    })();
    return () => { cancelled = true; };
  }, [taskRequests.length, allRunningWorkspaces]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Hold-to-talk: hold ½ key (Danish keyboard) to record, release to stop & transcribe
  const pttActiveRef = useRef(false);
  const voiceSupportedRef = useRef(voiceSupported);
  voiceSupportedRef.current = voiceSupported;
  const isListeningRef = useRef(isListening);
  isListeningRef.current = isListening;
  const isTranscribingRef = useRef(isTranscribing);
  isTranscribingRef.current = isTranscribing;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const isAnyRunningRef = useRef(isAnyRunning);
  isAnyRunningRef.current = isAnyRunning;
  const startListeningRef = useRef(startListening);
  startListeningRef.current = startListening;
  const stopListeningRef = useRef(stopListening);
  stopListeningRef.current = stopListening;

  useEffect(() => {
    const PTT_KEY = '½';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (!voiceSupportedRef.current || isTranscribingRef.current) return;
      if (sendingRef.current || isAnyRunningRef.current) return;
      if (!pttActiveRef.current && !isListeningRef.current) {
        pttActiveRef.current = true;
        setVoiceModeActive(true);
        playListenChime();
        startListeningRef.current();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY) return;
      e.preventDefault();
      e.stopPropagation();
      if (pttActiveRef.current && isListeningRef.current) {
        pttActiveRef.current = false;
        stopListeningRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, []);

  const handleSend = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (isListening) stopListening();
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    clearMessage();
    shouldForceScroll.current = true;
    setOptimisticMessage({
      id: `optimistic-${Date.now()}`,
      discussion_id: discussionId,
      role: 'user',
      content: trimmed,
      cost: null,
      username: null,
      participant_id: targetId,
      created_at: new Date().toISOString(),
    });
    try {
      if (targetId) {
        await sendParticipantMessage(discussionId, targetId, trimmed);
      } else {
        await sendDiscussionMessage(discussionId, trimmed);
      }
      await loadData();
    } catch {
      setMessage(trimmed);
    } finally {
      setSending(false);
      setOptimisticMessage(null);
    }
  };

  // Voice mode: auto-send when silence timeout sets the pending flag
  useEffect(() => {
    if (!voicePendingSendRef.current) return;
    voicePendingSendRef.current = false;
    const trimmed = message.trim();
    if (!trimmed || trimmed === '[BLANK_AUDIO]') {
      setMessage('');
      return;
    }
    handleSend();
  }, [message]);

  // Full set of agents the user can mention: host + invited participants.
  const mentionCandidates = useMemo(() => {
    const names = [workspaceName, ...participants.map(p => p.workspace_name)];
    // Deduplicate (shouldn't happen, but be safe) while preserving order.
    return Array.from(new Set(names));
  }, [workspaceName, participants]);

  // Filtered list shown in the dropdown based on the typed query.
  const mentionMatches = useMemo(() => {
    if (!mentionMenu.open) return [];
    const q = mentionMenu.query.toLowerCase();
    if (!q) return mentionCandidates;
    return mentionCandidates.filter(n => n.toLowerCase().includes(q));
  }, [mentionMenu.open, mentionMenu.query, mentionCandidates]);

  // Walk back from the caret to detect a valid "@query" being typed.
  // Returns the @ index and the query text, or null if not in a mention.
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

  // Run mention detection against a given text + caret. Used both from onChange
  // and from onSelect (so moving the caret next to an existing '@' re-opens the
  // menu) and after composition ends.
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

  const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);
    // Don't try to detect mid-IME composition — selection/value are unstable.
    if (isComposingRef.current) return;
    const caret = e.target.selectionStart ?? value.length;
    refreshMentionMenu(value, caret);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    const el = e.currentTarget;
    refreshMentionMenu(el.value, el.selectionStart ?? el.value.length);
  };

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;
    const el = e.currentTarget;
    refreshMentionMenu(el.value, el.selectionStart ?? el.value.length);
  };

  // Mobile-friendly: tap to insert "@" at the caret and open the menu directly,
  // bypassing any keyboard-event quirks (composition, autocorrect) that prevent
  // the onChange-based detection from firing.
  const openMentionMenu = () => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? message.length;
    const before = message.slice(0, caret);
    const after = message.slice(caret);
    // Insert a space before '@' if needed so detection always recognises it.
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsLeadingSpace ? ' ' : '') + '@';
    const next = before + insert + after;
    const atIndex = before.length + insert.length - 1; // position of the '@'
    setMessage(next);
    setMentionMenu({ open: true, anchorStart: atIndex, query: '', selectedIndex: 0 });
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      const c = atIndex + 1;
      t.setSelectionRange(c, c);
    });
  };

  const insertMention = (name: string) => {
    if (!mentionMenu.open || mentionMenu.anchorStart < 0) return;
    const before = message.slice(0, mentionMenu.anchorStart);
    const caret = textareaRef.current?.selectionStart ?? message.length;
    const after = message.slice(caret);
    // Insert "@Name " (with trailing space) so the next token starts cleanly.
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setMessage(next);
    setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
    // Restore caret position right after the inserted mention (next animation frame
    // because React updates the textarea value asynchronously).
    const newCaret = before.length + inserted.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      handleSend();
    }
  };

  const handleClose = async () => {
    if (!confirm('Close this discussion? You can start a new one later.')) return;
    await closeDiscussion(discussionId);
    onClose();
  };

  const handleApprove = async (requestId: string, targetWorkspaceId: string | null, targetName: string) => {
    if (processingRequest) return;
    if (targetWorkspaceId && targetWorkspaceId !== workspaceId) {
      const ok = confirm(
        `This task will run in "${targetName}", a DIFFERENT workspace from this discussion ("${workspaceName}"). ` +
        `It will be queued there and run with that workspace's project context. Continue?`
      );
      if (!ok) return;
    }
    setProcessingRequest(requestId);
    try {
      await approveTaskRequest(discussionId, requestId, targetWorkspaceId);
      onTaskCreated?.();
      await loadData();
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleChangeTarget = async (requestId: string, targetWorkspaceId: string) => {
    setRequestTargetOverride(prev => ({ ...prev, [requestId]: targetWorkspaceId }));
    try {
      await updateTaskRequestTarget(discussionId, requestId, targetWorkspaceId === workspaceId ? null : targetWorkspaceId);
    } catch (err) {
      console.error('Failed to update task request target:', err);
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
      <div className={`flex items-stretch gap-3 w-full ${preview.previewEffective ? '' : 'max-w-3xl'} max-h-[90vh]`}>
      <div className="bg-white dark:bg-gray-950 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-3xl shrink-0 max-h-[90vh] flex flex-col">
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
                    title={discussion.full_access ? 'Full Access — Claude can modify project files directly' : 'Project files are read-only — Claude proposes tasks for project changes'}
                  >
                    <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                      discussion.full_access ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`} />
                  </button>
                  <span className={`text-[10px] ${discussion.full_access ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}>
                    {discussion.full_access ? 'Full Access' : 'Project read-only'}
                  </span>
                </div>
              </div>
              <PreviewToggleButton state={preview} />
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

              {visibleMessages.map((msg) => {
                let onSpeak: ((text: string, msgId: string) => void) | undefined;
                if (ttsVoices.length > 0) {
                  const wsId = getMsgWorkspaceId(msg);
                  const explicit = wsVoiceSettings[wsId] ?? [];
                  const def = wsDefaultVoices[wsId];
                  const voiceIds = def && !explicit.includes(def) ? [...explicit, def] : explicit;
                  onSpeak = (text, mid) => {
                    if (ttsSpeakingId === mid) { ttsStop(); return; }
                    ttsSpeakAs(text, mid, voiceIds);
                  };
                }
                return <MessageRow key={msg.id} msg={msg} hostWorkspaceName={workspaceName} participants={participants} onSpeak={onSpeak} isSpeaking={ttsSpeakingId === msg.id} />;
              })}

              {optimisticMessage && (
                <div className="opacity-70">
                  <MessageRow msg={optimisticMessage} hostWorkspaceName={workspaceName} participants={participants} />
                </div>
              )}

              {/* Working indicator */}
              {(isAnyRunning || sending) && (
                <div className={`text-sm p-4 rounded-lg border ${
                  runningParticipant
                    ? 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20 border-teal-100 dark:border-teal-800'
                    : 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800'
                }`}>
                  <div className="flex items-center gap-2">
                    <div className={`animate-spin h-4 w-4 border-2 border-t-transparent rounded-full ${
                      runningParticipant ? 'border-teal-600 dark:border-teal-400' : 'border-purple-600 dark:border-purple-400'
                    }`} />
                    <span>{isAnyRunning ? `${runningAgentName || 'Agent'} is thinking...` : 'Sending message...'}</span>
                    {(discussion.activity || runningParticipant?.activity) && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                        {timeAgo((runningParticipant?.activity || discussion.activity)!.timestamp)}
                      </span>
                    )}
                    {isAnyRunning && (
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
                    )}
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
              {taskRequests.map((tr) => {
                const selectedTargetId = requestTargetOverride[tr.id] ?? tr.target_workspace_id ?? workspaceId;
                const isCrossWorkspace = selectedTargetId !== workspaceId;
                const selectedWorkspace = allRunningWorkspaces?.find(w => w.id === selectedTargetId);
                const selectedTargetName = isCrossWorkspace
                  ? (selectedWorkspace?.name ?? tr.target_workspace_name ?? 'unknown')
                  : workspaceName;
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
                      <label htmlFor={`target-${tr.id}`}>Run in:</label>
                      <select
                        id={`target-${tr.id}`}
                        value={selectedTargetId}
                        onChange={(e) => handleChangeTarget(tr.id, e.target.value)}
                        disabled={processingRequest !== null}
                        className="text-xs px-2 py-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded disabled:opacity-50"
                      >
                        <option value={workspaceId}>{workspaceName} (this workspace)</option>
                        {(allRunningWorkspaces ?? [])
                          .filter(ws => ws.id !== workspaceId)
                          .map(ws => (
                            <option key={ws.id} value={ws.id}>{ws.name}</option>
                          ))}
                        {/* If the agent suggested a target that isn't in the loaded list yet, still show it */}
                        {tr.target_workspace_id && tr.target_workspace_id !== workspaceId &&
                          !(allRunningWorkspaces ?? []).some(ws => ws.id === tr.target_workspace_id) && (
                            <option value={tr.target_workspace_id}>{tr.target_workspace_name ?? 'unknown'}</option>
                          )}
                      </select>
                    </div>
                    {isCrossWorkspace && (
                      <p className="text-xs text-rose-700 dark:text-rose-300 mb-3">
                        ⚠ This task will be queued in <strong>{selectedTargetName}</strong>, not in this discussion's workspace. You'll be asked to confirm.
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApprove(tr.id, isCrossWorkspace ? selectedTargetId : null, selectedTargetName)}
                        disabled={processingRequest !== null}
                        className={createBtnClass}
                      >
                        {processingRequest === tr.id
                          ? 'Creating...'
                          : isCrossWorkspace ? `Create in ${selectedTargetName}` : 'Create Task'}
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
                );
              })}
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
                  {/* @-mention trigger — works on mobile where the keyboard may not fire
                      the @ keypress reliably. */}
                  <button
                    type="button"
                    onClick={openMentionMenu}
                    title="Mention an agent"
                    className="text-xs px-2 py-1 rounded-full border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-teal-400 hover:text-teal-600 dark:hover:border-teal-600 dark:hover:text-teal-400 transition-colors"
                  >
                    @ Mention
                  </button>
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
                <div className="relative">
                  <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={handleMessageChange}
                    onKeyDown={handleKeyDown}
                    onSelect={handleSelect}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={handleCompositionEnd}
                    placeholder={isAnyRunning
                      ? `${runningAgentName || 'Agent'} is thinking...`
                      : participants.length > 0
                        ? `Message ${targetName}... (type @ to mention)`
                        : `Message ${targetName}...`}
                    rows={3}
                    autoFocus
                    disabled={sending || isAnyRunning}
                    className={`w-full px-3 py-2 border bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 resize-y disabled:opacity-50 ${
                      targetId
                        ? 'border-teal-300 dark:border-teal-700 focus:ring-teal-500'
                        : 'border-gray-300 dark:border-gray-700 focus:ring-purple-500'
                    }`}
                  />
                  {mentionMenu.open && mentionMatches.length > 0 && (
                    <div
                      className="absolute bottom-full left-0 mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] max-h-[200px] overflow-y-auto"
                      role="listbox"
                    >
                      <div className="px-3 py-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
                        Mention agent
                      </div>
                      {mentionMatches.map((name, idx) => {
                        const isHost = name === workspaceName;
                        const isSelected = idx === mentionMenu.selectedIndex;
                        return (
                          <button
                            key={name}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            onMouseDown={(e) => {
                              // Prevent textarea blur before click fires.
                              e.preventDefault();
                              insertMention(name);
                            }}
                            onMouseEnter={() => setMentionMenu(m => ({ ...m, selectedIndex: idx }))}
                            className={`w-full text-left text-xs px-3 py-2 flex items-center gap-2 ${
                              isSelected
                                ? isHost
                                  ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                                  : 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300'
                                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                            }`}
                          >
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full ${
                                isHost ? 'bg-purple-500' : 'bg-teal-500'
                              }`}
                            />
                            <span className="font-medium">{name}</span>
                            {isHost && (
                              <span className="ml-auto text-[10px] uppercase opacity-60">host</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleClose}
                      className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    >
                      End Discussion
                    </button>
                    {kokoroLoading && (
                      <span className="text-[10px] text-purple-500 dark:text-purple-400 whitespace-nowrap animate-pulse">
                        {kokoroProgress > 0 && kokoroProgress < 100 ? `Kokoro ${kokoroProgress}%` : 'Loading Kokoro…'}
                      </span>
                    )}
                    {kokoroError && !kokoroLoading && (
                      <span className="text-[10px] text-red-500 dark:text-red-400 whitespace-nowrap truncate max-w-[140px]" title={kokoroError}>
                        Kokoro error
                      </span>
                    )}
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
                  <div className="flex items-center gap-2">
                    {voiceDebug && (
                      <span className={`text-xs truncate max-w-[220px] ${
                        isTranscribing
                          ? 'text-amber-500 dark:text-amber-400 animate-pulse'
                          : isListening
                          ? 'text-purple-500 dark:text-purple-400 animate-pulse'
                          : 'text-gray-400 dark:text-gray-500'
                      }`} title={voiceDebug}>
                        {voiceDebug}
                      </span>
                    )}
                    {voiceSupported && ttsVoices.length > 0 && (
                      <button
                        type="button"
                        onClick={toggleConversationMode}
                        className={`p-2 rounded-md transition-colors ${
                          conversationMode
                            ? 'text-white bg-purple-600 hover:bg-purple-700'
                            : 'text-gray-400 dark:text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20'
                        }`}
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
                          isTranscribing
                            ? 'text-amber-600 bg-amber-100 dark:bg-amber-900/30'
                            : isListening
                            ? 'text-white bg-purple-600 voice-pulse-ring'
                            : voiceModeActive
                            ? 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30 hover:bg-purple-200 dark:hover:bg-purple-900/50'
                            : 'text-gray-400 dark:text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20'
                        }`}
                        title={isTranscribing ? 'Transcribing...' : isListening ? 'Stop recording' : useWhisper ? 'Push to talk (hold ½)' : voiceModeActive ? 'Resume listening' : 'Start voice mode'}
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
                </div>
              </form>
            </div>
          </>
        )}
      </div>
      {preview.previewEffective && <WorkspacePreviewPanel state={preview} />}
      </div>
    </div>
  );
}
