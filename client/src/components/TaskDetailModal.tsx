import React, { useState, useEffect, useRef, useMemo, useCallback, type FormEvent } from 'react';
import {
  getTaskDetail,
  getStreamLog,
  replyToTask,
  completeTask,
  reopenTask,
  retryTask,
  reviewTask,
  resetTaskSession,
  compactTaskSession,
  updateTaskTitle,
  getClaudeAccounts,
  setTaskAutoReview,
  setTaskClaudeAccount,
  setTaskModel,
  setTaskReviewerModel,
  getModels,
  WORKSPACE_CLAUDE_ACCOUNT,
  interruptTask,
  wakeTaskNow,
  cancelTaskWake,
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
  type ClaudeAccount,
  type ModelInfo,
  type Message,
  type StreamLogEntry,
  type TaskParticipant,
  type TaskTurn,
  type Workspace,
  type AttachmentInfo,
  type TaskRequestItem,
  type ReviewFinding,
  setFindingState,
  fixFindings,
} from '../api/client';
import { playChime } from '../utils/chime';
import { playListenChime } from '../utils/listenChime';
import RateLimitBanner from './RateLimitBanner';
import { useDraft } from '../hooks/useDraft';
import { useWorkspacePreview } from '../hooks/useWorkspacePreview';
import WorkspacePreviewPanel, { PreviewToggleButton } from './WorkspacePreviewPanel';
import { linkify } from '../utils/linkify';
import Markdown from './Markdown';
import { useLightbox, type LightboxImage } from './ImageLightbox';
import PendingFiles from './PendingFiles';
import MarkdownComposer, { type ComposerHandle, type ComposerKeyEvent } from './MarkdownComposer';
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

// Assistant messages keep the raw [TASK_REQUEST] block the server parsed into a
// task_requests row (the interactive colored card). Rendering the block verbatim
// duplicates the card, so collapse it to a compact one-line quote — which also
// keeps a trace in the chat after the card disappears on approve/dismiss.
// Unparseable JSON is left as-is: the server created no card for it either.
function collapseTaskRequestBlocks(content: string): string {
  return content.replace(/\[TASK_REQUEST\]\s*([\s\S]*?)\s*\[\/TASK_REQUEST\]/g, (block, body) => {
    let prompt: string;
    try {
      const data = JSON.parse(body);
      if (typeof data.prompt !== 'string' || !data.prompt.trim()) return block;
      prompt = data.prompt.trim().replace(/\s+/g, ' ');
    } catch {
      return block;
    }
    if (prompt.length > 140) prompt = prompt.slice(0, 140) + '…';
    return `\n\n> 📋 **Proposed task:** ${prompt}\n\n`;
  });
}

// Assistant messages keep the raw [OUTPUT_FILE] block the server parsed into
// an attachment (rendered as a download pill right under that same message).
// Collapse it to a short note here so the user sees the intent, not the raw
// JSON directive — the actual download link is the pill, tied to the message
// by id server-side rather than matched by filename.
//
// `previewedNames` are files already shown as inline thumbnails under this
// message; for those the note is dropped entirely, since the image itself
// (captioned with the same filename) says everything the note would.
function collapseOutputFileBlocks(content: string, previewedNames?: Set<string>): string {
  return content.replace(/\[OUTPUT_FILE\]\s*([\s\S]*?)\s*\[\/OUTPUT_FILE\]/g, (block, body) => {
    let name: string;
    try {
      const data = JSON.parse(body);
      const path = typeof data.path === 'string' ? data.path.trim() : '';
      name = (typeof data.name === 'string' && data.name.trim()) || path.split('/').pop() || '';
      if (!name) return block;
    } catch {
      return block;
    }
    if (previewedNames?.has(name)) return '\n\n';
    return `\n\n> 📎 **Generated file:** ${name}\n\n`;
  });
}

// Mime types the download route is willing to serve inline (see the
// INLINE_IMAGE_TYPES allow-list in server/routes/uploads.ts). Anything else —
// including SVG — comes back as an octet-stream attachment and can't be shown
// in an <img>, so it stays a download pill.
const PREVIEWABLE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
]);

function isPreviewableImage(att: AttachmentInfo): boolean {
  const type = (att.mime_type || '').split(';')[0].trim().toLowerCase();
  return PREVIEWABLE_IMAGE_TYPES.has(type);
}

const attachmentUrl = (att: AttachmentInfo) => `/api/uploads/${att.id}`;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Inline thumbnail for an image attachment — an agent-generated image is
 * usually the whole point of the message, so showing it beats a pill that has
 * to be clicked to find out what it is. Clicking opens the shared lightbox
 * rather than navigating away to a bare image tab.
 *
 * Falls back to the plain pill if the bytes don't decode as an image (a wrong
 * mime type on the attachment shouldn't leave a broken-image icon with no way
 * to get at the file).
 */
function AttachmentImage({ att, onOpen }: { att: AttachmentInfo; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <AttachmentPill att={att} />;
  return (
    <figure className="m-0 inline-block max-w-full">
      <button
        type="button"
        onClick={onOpen}
        className={`block overflow-hidden rounded-lg border transition-colors ${
          att.source === 'agent'
            ? 'border-green-200 dark:border-green-800 hover:border-green-400 dark:hover:border-green-600'
            : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600'
        }`}
        title={`${att.original_name} (${formatSize(att.size)}) — click to enlarge`}
      >
        <img
          src={attachmentUrl(att)}
          alt={att.original_name}
          loading="lazy"
          onError={() => setBroken(true)}
          className="block max-h-64 max-w-full object-contain bg-gray-50 dark:bg-gray-800"
        />
      </button>
      <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
        {att.source === 'agent' && (
          <svg className="w-3 h-3 shrink-0 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" /></svg>
        )}
        <span className="truncate max-w-[16rem]">{att.original_name}</span>
        <a
          href={attachmentUrl(att)}
          download={att.original_name}
          className="shrink-0 underline hover:text-blue-600 dark:hover:text-blue-400"
        >
          Download
        </a>
      </figcaption>
    </figure>
  );
}

/**
 * The attachments belonging to one message: images as inline thumbnails (all
 * of them opening into the same lightbox so arrow keys page through the set),
 * everything else as download pills.
 */
function AttachmentGroup({ attachments }: { attachments: AttachmentInfo[] }) {
  const lightbox = useLightbox();
  const images = attachments.filter(isPreviewableImage);
  const files = attachments.filter(a => !isPreviewableImage(a));
  const gallery: LightboxImage[] = images.map(a => ({ src: attachmentUrl(a), name: a.original_name }));

  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap items-start gap-2">
          {images.map((att, i) =>
            lightbox
              ? <AttachmentImage key={att.id} att={att} onOpen={() => lightbox.open(gallery, i)} />
              : <AttachmentPill key={att.id} att={att} />
          )}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map(att => <AttachmentPill key={att.id} att={att} />)}
        </div>
      )}
    </div>
  );
}

// A single downloadable attachment pill — a green download icon for a file
// the agent produced ([OUTPUT_FILE]), a gray paperclip for one the user
// uploaded. Rendered inline under the message it's tied to (see message_id).
function AttachmentPill({ att }: { att: AttachmentInfo }) {
  return (
    <a
      href={attachmentUrl(att)}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border transition-colors ${
        att.source === 'agent'
          ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:border-green-400 dark:hover:border-green-600'
          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-600 dark:hover:text-blue-400'
      }`}
      title={`${att.source === 'agent' ? 'Generated by the agent — ' : ''}${att.original_name} (${formatSize(att.size)})`}
    >
      {att.source === 'agent' ? (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" /></svg>
      ) : (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
      )}
      {att.original_name}
    </a>
  );
}

// Assistant messages keep the raw [WAKE] block the server parsed into the
// task's scheduled wake-up (the banner above the composer). Collapse it to a
// one-line note so the chat records that the agent armed one, without showing
// the raw directive — and so it still reads sensibly after the wake has fired
// and the banner is gone.
function collapseWakeBlocks(content: string): string {
  return content.replace(/\[WAKE\]\s*([\s\S]*?)\s*\[\/WAKE\]/g, (block, body) => {
    try {
      const data = JSON.parse(body);
      const after = typeof data.after === 'string' ? data.after : typeof data.after === 'number' ? `${data.after}m` : '';
      if (!after) return block;
      const file = typeof data.when_file === 'string' ? data.when_file : '';
      return `\n\n> ⏰ **Wake-up scheduled:** in ${after}${file ? `, or as soon as \`${file}\` appears` : ''}\n\n`;
    } catch {
      return block;
    }
  });
}

/** "in 12m" / "in 2h 5m" / "any moment now" for a future ISO timestamp. */
function timeUntil(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 5) return 'any moment now';
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `in ${hours}h${rem ? ` ${rem}m` : ''}`;
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  working: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  awaiting_feedback: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
  completed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  cancelled: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
};

/**
 * Assumed model context window, for turning a raw token count into a
 * proportion. Every Claude model CPM offers is 200k; Ollama models vary, so the
 * tooltip states the assumption rather than presenting the percentage as fact.
 */
const CONTEXT_WINDOW_TOKENS = 200_000;
/** Amber from here — enough headroom left to compact deliberately. */
const CONTEXT_WARN_RATIO = 0.6;
/** Red from here — compact now or the next turn may not fit. */
const CONTEXT_DANGER_RATIO = 0.8;

/**
 * Live context usage for the task's Claude session.
 *
 * Exists because running out of context is CPM's most disorienting failure: the
 * task simply stops responding, and the only signal today is the
 * `context_window_exceeded` error AFTER it has already happened — typically
 * with uncommitted work stranded in the worktree. This makes the approach
 * visible while there is still room to act, and doubles as the shortcut for
 * acting on it.
 *
 * Hidden until a session has actually reported usage (tokens === 0), so tasks
 * that have never run don't show a meaningless empty gauge.
 */
function ContextMeter({ tokens, onCompact, compacting }: {
  tokens: number;
  onCompact: () => void;
  compacting: boolean;
}) {
  if (!tokens) return null;
  const ratio = Math.min(tokens / CONTEXT_WINDOW_TOKENS, 1);
  const pct = Math.round(ratio * 100);
  const danger = ratio >= CONTEXT_DANGER_RATIO;
  const warn = !danger && ratio >= CONTEXT_WARN_RATIO;

  const tone = danger
    ? 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20'
    : warn
      ? 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20'
      : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800';
  const barTone = danger ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-gray-400 dark:bg-gray-500';

  const label = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);

  return (
    <button
      type="button"
      onClick={onCompact}
      disabled={compacting}
      className={`inline-flex items-center gap-2 text-xs px-3 py-2 border rounded-md transition-colors disabled:opacity-50 ${tone}`}
      title={
        `Context: ${tokens.toLocaleString()} tokens (~${pct}% of an assumed ${CONTEXT_WINDOW_TOKENS / 1000}k window).\n` +
        (danger
          ? 'Close to the limit — compact now to avoid the session failing mid-turn.'
          : warn
            ? 'Growing large. Compacting now summarizes prior turns and frees room.'
            : 'Click to compact: summarizes prior turns and frees room. The session is preserved.')
      }
    >
      <span className="hidden sm:inline">Context</span>
      <span className="w-12 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden" aria-hidden="true">
        <span className={`block h-full rounded-full ${barTone}`} style={{ width: `${Math.max(pct, 3)}%` }} />
      </span>
      <span className="font-medium tabular-nums">{compacting ? '…' : label}</span>
    </button>
  );
}

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
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccount[]>([]);
  // Distinguishes "no accounts" from "haven't loaded / load failed", so a pinned
  // account is never mislabelled as removed just because the fetch failed.
  // Tri-state, not a boolean: a failed fetch must not be treated as "no accounts".
  // A task pinned to an account still needs the switcher rendered so it can be
  // re-pointed — that control is what AUTH_STAGING_MESSAGE tells the user to use —
  // but we must not claim the pinned account was *removed* when we simply couldn't
  // load the list.
  const [accountsState, setAccountsState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [switchingReviewerModel, setSwitchingReviewerModel] = useState(false);
  const [switchingAutoReview, setSwitchingAutoReview] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [wakeBusy, setWakeBusy] = useState(false);
  // Ticks only while a wake-up is armed, so the "waking in 12m" countdown keeps
  // moving. The task row itself doesn't change while sleeping, so the normal
  // poll — which only re-renders on a changed row — would leave it frozen.
  const [, setWakeClockTick] = useState(0);
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
  // Per-finding triage: each reviewer issue is individually fixable or
  // dismissable. `pendingFinding` marks the row whose request is in flight.
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [pendingFinding, setPendingFinding] = useState<string | null>(null);
  const [dismissNoteFor, setDismissNoteFor] = useState<string | null>(null);
  const [dismissNote, setDismissNote] = useState('');
  const [unresolvedOpen, setUnresolvedOpen] = useState(false);
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set());
  const [resolvingGitIssues, setResolvingGitIssues] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastParticipantsJsonRef = useRef('');

  // @-mention autocomplete. Same shape and behavior as DiscussionModal — when
  // there are participants, typing '@' (or tapping the "@ Mention" pill on
  // mobile) opens a picker for inserting an agent name into the reply.
  // The composer owns its own caret plumbing (CodeMirror on desktop, textarea on
  // touch), so mention insertion goes through this handle rather than a DOM node.
  const composerRef = useRef<ComposerHandle>(null);
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
  // Bumped by every local edit to the task row so an in-flight poll can tell its
  // response predates the edit and skip applying it. See loadData.
  const editSeqRef = useRef(0);
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
    // Snapshot the edit counter before the await. A poll in flight across a local
    // edit (title / model / subscription) carries the pre-edit row, which would
    // overwrite the optimistic value and re-seed lastTaskJsonRef with stale JSON —
    // making the control visibly snap back for a whole poll interval before
    // self-healing. Edits bump the counter both before and after their request, so
    // a poll started mid-request is invalidated too: its server read can predate
    // the commit even though it began after the pre-bump.
    const seqAtStart = editSeqRef.current;
    try {
      const { task: newTask, messages: newMessages, participants: newParticipants, attachments: newAttachments, turns: newTurns, taskRequests: newTaskRequests, findings: newFindings } = await getTaskDetail(taskId);
      setTaskRequests(newTaskRequests || []);
      if (prevStatusRef.current && prevStatusRef.current !== 'awaiting_feedback' && newTask.status === 'awaiting_feedback') {
        playChime();
      }
      prevStatusRef.current = newTask.status;
      taskStatusRef.current = newTask.status;
      const taskJson = JSON.stringify(newTask);
      // Drop this response's task row if an edit landed while it was in flight;
      // the next poll picks up the server's authoritative version.
      if (taskJson !== lastTaskJsonRef.current && editSeqRef.current === seqAtStart) {
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
      // Don't clobber an in-flight local triage decision with a poll response
      // that predates it — same hazard as the task row above.
      if (newFindings && editSeqRef.current === seqAtStart) setFindings(newFindings);
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

  // Keep the wake-up countdown honest while nothing else is changing.
  useEffect(() => {
    if (!task?.wake_at || task.status !== 'awaiting_feedback') return;
    const id = setInterval(() => setWakeClockTick(t => t + 1), 15000);
    return () => clearInterval(id);
  }, [task?.wake_at, task?.status]);

  // CPM-held Claude subscriptions, so the header can offer a switch. Fetched once
  // per open — the list changes only when the user edits it in settings.
  useEffect(() => {
    let cancelled = false;
    setAccountsState('loading');
    getClaudeAccounts()
      .then(({ accounts }) => { if (!cancelled) { setClaudeAccounts(accounts); setAccountsState('loaded'); } })
      .catch(() => { if (!cancelled) { setClaudeAccounts([]); setAccountsState('failed'); } });
    return () => { cancelled = true; };
  }, [taskId]);

  // Model list for the mid-task model switcher. Needs the workspace (the Anthropic
  // list is fetched through it), so it waits for the task to load. On failure the
  // header falls back to a static chip rather than offering an empty picker.
  const modelsWorkspaceId = task?.workspace_id;
  useEffect(() => {
    if (!modelsWorkspaceId) return;
    let cancelled = false;
    // Clear first: the Anthropic list is fetched over SSH with a 20s timeout, so on
    // a cold cache the previous workspace's list would otherwise stay on screen for
    // that whole window — offering models this workspace may not have, and marking
    // valid ones "(unavailable)". Empty falls back to the static chip.
    setAvailableModels([]);
    getModels(modelsWorkspaceId)
      .then(({ models }) => { if (!cancelled) setAvailableModels(models); })
      .catch(() => { if (!cancelled) setAvailableModels([]); });
    return () => { cancelled = true; };
  }, [modelsWorkspaceId]);

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

  // caret is null mid-IME-composition; the caret settles on the following
  // onCaretMove, so mention detection just waits for that.
  const handleReplyChange = (value: string, caret: number | null) => {
    setReply(value);
    if (caret === null) return;
    refreshMentionMenu(value, caret);
  };

  const handleReplyCaretMove = (value: string, caret: number) => {
    refreshMentionMenu(value, caret);
  };

  const openMentionMenu = () => {
    const caret = composerRef.current?.getCaret() ?? reply.length;
    const before = reply.slice(0, caret);
    const after = reply.slice(caret);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsLeadingSpace ? ' ' : '') + '@';
    const next = before + insert + after;
    const atIndex = before.length + insert.length - 1;
    setReply(next);
    setMentionMenu({ open: true, anchorStart: atIndex, query: '', selectedIndex: 0 });
    // Set synchronously, not in a rAF: the composer holds the requested caret
    // until it has absorbed the new value, so there is no frame to race.
    composerRef.current?.focus();
    composerRef.current?.setCaret(atIndex + 1);
  };

  const insertMention = (name: string) => {
    if (!mentionMenu.open || mentionMenu.anchorStart < 0) return;
    const before = reply.slice(0, mentionMenu.anchorStart);
    const caret = composerRef.current?.getCaret() ?? reply.length;
    const after = reply.slice(caret);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setReply(next);
    setMentionMenu({ open: false, anchorStart: -1, query: '', selectedIndex: 0 });
    const newCaret = before.length + inserted.length;
    composerRef.current?.focus();
    composerRef.current?.setCaret(newCaret);
  };

  const handleReplyKeyDown = (e: ComposerKeyEvent) => {
    if (e.ctrlKey && e.key === 'ArrowUp') {
      e.preventDefault();
      scrollBodyRef.current?.scrollBy({ top: -200, behavior: 'smooth' });
      return;
    }
    if (e.ctrlKey && e.key === 'ArrowDown') {
      e.preventDefault();
      scrollBodyRef.current?.scrollBy({ top: 200, behavior: 'smooth' });
      return;
    }
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
  const handleParticipantReplyKeyDown = (e: ComposerKeyEvent) => {
    if (e.ctrlKey && e.key === 'ArrowUp') {
      e.preventDefault();
      scrollBodyRef.current?.scrollBy({ top: -200, behavior: 'smooth' });
      return;
    }
    if (e.ctrlKey && e.key === 'ArrowDown') {
      e.preventDefault();
      scrollBodyRef.current?.scrollBy({ top: 200, behavior: 'smooth' });
      return;
    }
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

  // Findings for one reviewer turn, in the order the reviewer listed them.
  const findingsForTurn = (turnId: string): ReviewFinding[] =>
    findings.filter(f => f.turn_id === turnId).sort((a, b) => a.position - b.position);

  const turnNumberOf = (turnId: string): number =>
    turns.find(t => t.id === turnId)?.turn_number ?? 0;

  /**
   * Whether a later reviewer pass ran after this finding was raised without
   * re-raising it. That is evidence it was resolved — the implementer resumes
   * with full context and often fixes neighbouring issues it can still see —
   * but it is NOT proof, since a fresh reviewer session can simply miss it. So
   * this only ever labels the finding; it never decides it. Silently dropping
   * these is precisely the "did it assume I wanted to ignore it?" failure.
   */
  const supersededByLaterReview = (f: ReviewFinding): boolean => {
    if (f.state !== 'open') return false;
    // A re-raised finding was explicitly looked at and objected to by a later
    // review, so "a later review didn't raise this again" is flatly false for
    // it. This heuristic only still applies to findings that never went through
    // the implementer loop — anything that did now carries a real verdict
    // (`verified`, or a re-raise) instead of this guess.
    if (f.revision > 0 || f.note) return false;
    const raisedAt = turnNumberOf(f.turn_id);
    return turns.some(t => t.role === 'reviewer' && t.completed_at && t.turn_number > raisedAt);
  };

  // Every finding still awaiting a decision, oldest first, across all turns.
  const unresolvedFindings = (): ReviewFinding[] =>
    findings
      .filter(f => f.state === 'open')
      .sort((a, b) => turnNumberOf(a.turn_id) - turnNumberOf(b.turn_id) || a.position - b.position);

  /**
   * Send one or more findings to the implementer as a single turn. `busyKey`
   * is what `pendingFinding` is set to while in flight, so the caller decides
   * which control shows the spinner (a finding row, or a "fix all" button).
   */
  const handleFixFindings = async (selected: ReviewFinding[], busyKey: string) => {
    if (pendingFinding || sending || applyingFixes) return;
    // 'fixing' is re-sendable: it means "handed to the implementer, outcome
    // unknown". Only an explicit dismissal takes a finding out of play.
    const ids = selected.filter(f => f.state === 'open').map(f => f.id);
    if (ids.length === 0) return;
    setPendingFinding(busyKey);
    editSeqRef.current++;
    try {
      const { findings: updated } = await fixFindings(taskId, ids);
      setFindings(updated);
      onTaskChanged?.();
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to send findings to the implementer');
    } finally {
      editSeqRef.current++;
      setPendingFinding(null);
    }
  };

  const handleFixFinding = (finding: ReviewFinding) => handleFixFindings([finding], finding.id);

  // Fix every still-open finding in this verdict in one implementer turn.
  const handleFixAllOpen = (turnId: string) =>
    handleFixFindings(findingsForTurn(turnId).filter(f => f.state === 'open'), turnId);

  // Dismiss a finding. This is the durable signal: dismissed findings are
  // replayed into every later reviewer prompt as a waiver, so the reviewer
  // stops re-raising them despite starting a fresh session each pass.
  const handleDismissFinding = async (finding: ReviewFinding, note: string) => {
    if (pendingFinding) return;
    setPendingFinding(finding.id);
    editSeqRef.current++;
    try {
      const { findings: updated } = await setFindingState(taskId, finding.id, 'dismissed', note);
      setFindings(updated);
      setDismissNoteFor(null);
      setDismissNote('');
    } catch (err: any) {
      alert(err?.message || 'Failed to dismiss finding');
    } finally {
      editSeqRef.current++;
      setPendingFinding(null);
    }
  };

  /**
   * "Already fixed" — distinct from Ignore. Both retire the finding, but they
   * tell the next reviewer opposite things ("don't change this" vs "verify this
   * is done"), so they must not collapse into one action. Users were dismissing
   * with a note of "Fixed", which fed the reviewer the wrong signal.
   */
  const handleResolveFinding = async (finding: ReviewFinding) => {
    if (pendingFinding) return;
    setPendingFinding(finding.id);
    editSeqRef.current++;
    try {
      const { findings: updated } = await setFindingState(taskId, finding.id, 'resolved');
      setFindings(updated);
    } catch (err: any) {
      alert(err?.message || 'Failed to mark finding as fixed');
    } finally {
      editSeqRef.current++;
      setPendingFinding(null);
    }
  };

  const handleReopenFinding = async (finding: ReviewFinding) => {
    if (pendingFinding) return;
    setPendingFinding(finding.id);
    editSeqRef.current++;
    try {
      const { findings: updated } = await setFindingState(taskId, finding.id, 'open');
      setFindings(updated);
    } catch (err: any) {
      alert(err?.message || 'Failed to reopen finding');
    } finally {
      editSeqRef.current++;
      setPendingFinding(null);
    }
  };

  const handleResolveGitIssues = async () => {
    if (resolvingGitIssues || sending) return;
    setResolvingGitIssues(true);
    try {
      // completeAfter: once the agent finishes fixing, completion runs
      // automatically — under the workspace lock, right after the fix — so
      // another task can't advance the default branch and re-break the merge
      // before a manual "Retry completion" click.
      await replyToTask(taskId,
        'The git operations failed when completing this task. Please review the error messages above and resolve any git issues (push conflicts, merge errors, branch protection issues, uncommitted changes, etc.). Once resolved, completion will run automatically.',
        undefined,
        { completeAfter: true },
      );
      onTaskChanged?.();
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to send request');
    } finally {
      setResolvingGitIssues(false);
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

  const handleReview = async () => {
    setReviewing(true);
    try {
      await reviewTask(taskId);
      // Reviewer is now running — reload so the modal reflects the working state.
      await loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to start review');
    } finally {
      setReviewing(false);
    }
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

  const handleWakeNow = async () => {
    setWakeBusy(true);
    try {
      await wakeTaskNow(taskId);
      if (onTaskChanged) onTaskChanged();
      await loadData();
    } finally {
      setWakeBusy(false);
    }
  };

  const handleCancelWake = async () => {
    setWakeBusy(true);
    try {
      await cancelTaskWake(taskId);
      if (onTaskChanged) onTaskChanged();
      await loadData();
    } finally {
      setWakeBusy(false);
    }
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
    editSeqRef.current++;
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
      // Second bump: invalidates any poll that started during the request,
      // whose server read may still predate the commit.
      editSeqRef.current++;
      setSavingTitle(false);
    }
  };

  /**
   * Switch the model for the task's remaining turns. The turn currently running
   * keeps the model it launched with — nothing interrupts it.
   */
  const handleChangeModel = async (value: string) => {
    if (!task) return;
    setSwitchingModel(true);
    editSeqRef.current++;
    try {
      const { task: updated } = await setTaskModel(taskId, value || null);
      setTask(prev => (prev ? { ...prev, model: updated.model } : prev));
      lastTaskJsonRef.current = '';
      onTaskChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to change model');
    } finally {
      // Second bump: invalidates any poll that started during the request,
      // whose server read may still predate the commit.
      editSeqRef.current++;
      setSwitchingModel(false);
    }
  };

  /**
   * Move the task to a different Claude subscription. Applies from the next turn
   * — the escape hatch when the current subscription hits its rate limit and you
   * want to finish the task on the other one instead of waiting for the reset.
   */
  const handleChangeClaudeAccount = async (value: string) => {
    if (!task) return;
    const accountId = value === WORKSPACE_CLAUDE_ACCOUNT ? null : value;
    setSwitchingAccount(true);
    editSeqRef.current++;
    try {
      const { task: updated } = await setTaskClaudeAccount(taskId, accountId);
      setTask(prev => (prev ? { ...prev, claude_account_id: updated.claude_account_id } : prev));
      lastTaskJsonRef.current = '';
      onTaskChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to change subscription');
    } finally {
      // Second bump: invalidates any poll that started during the request,
      // whose server read may still predate the commit.
      editSeqRef.current++;
      setSwitchingAccount(false);
    }
  };

  /**
   * Pin the auto-reviewer to its own model, independent of the implementer's.
   * Applies from the next review pass; a reviewer already running keeps the
   * model it launched with. Empty value clears the override.
   */
  const handleChangeReviewerModel = async (value: string) => {
    if (!task) return;
    setSwitchingReviewerModel(true);
    editSeqRef.current++;
    try {
      const { task: updated } = await setTaskReviewerModel(taskId, value || null);
      setTask(prev => (prev ? { ...prev, reviewer_model: updated.reviewer_model } : prev));
      lastTaskJsonRef.current = '';
      onTaskChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to change reviewer model');
    } finally {
      // Second bump: invalidates any poll that started during the request,
      // whose server read may still predate the commit.
      editSeqRef.current++;
      setSwitchingReviewerModel(false);
    }
  };

  /**
   * Turn the auto-review pass on or off for the rest of this conversation.
   * Applies from the next decision point: a reviewer already running finishes,
   * but its verdict no longer bounces back to the implementer, and no later turn
   * launches a new one. The exception is a reviewer started with the Review
   * button — a manual pass is exempt, so its verdict still routes back for one
   * fix turn. The server also logs the change as a system message, which the
   * next poll picks up.
   */
  const handleChangeAutoReview = async (enabled: boolean) => {
    if (!task) return;
    setSwitchingAutoReview(true);
    editSeqRef.current++;
    try {
      const { task: updated } = await setTaskAutoReview(taskId, enabled);
      setTask(prev => (prev ? { ...prev, auto_review: updated.auto_review } : prev));
      lastTaskJsonRef.current = '';
      onTaskChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to change auto-review');
    } finally {
      // Second bump: invalidates any poll that started during the request,
      // whose server read may still predate the commit.
      editSeqRef.current++;
      setSwitchingAutoReview(false);
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

  // One reviewer finding as an independently actionable row. Fix sends just this
  // issue back to the implementer; Ignore waives it ("do not change this");
  // Mark fixed asserts it is already done ("verify, don't restate"). Ignore and
  // Mark fixed both retire the finding but carry opposite meanings to the next
  // reviewer, so they are separate actions.
  // `scope` distinguishes the two places a finding can appear (its turn card and
  // the pinned unresolved panel) so opening the dismiss note in one doesn't also
  // open — and autoFocus — a second input in the other.
  const renderFinding = (f: ReviewFinding, index: number, canAct: boolean, scope = 'card', compact = false) => {
    const noteKey = `${scope}:${f.id}`;
    const busy = pendingFinding === f.id;
    const dismissed = f.state === 'dismissed';
    const resolved = f.state === 'resolved';
    const verified = f.state === 'verified';
    const claimedFixed = f.state === 'fixed';
    const inFlight = f.state === 'fixing';
    const decided = f.state !== 'open';
    const noteOpen = dismissNoteFor === noteKey;
    // In the pinned panel the bodies are clamped: reviewer findings run to a
    // full paragraph each, and a handful at full length pushed the conversation
    // and the composer off screen entirely.
    const clamped = compact && !expandedFindings.has(noteKey);

    return (
      <div
        key={f.id}
        className={`rounded-md border p-2.5 ${
          decided
            ? 'border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-800/40'
            : 'border-amber-200 dark:border-amber-800 bg-white/60 dark:bg-gray-900/30'
        }`}
      >
        <div className="flex items-start gap-2">
          <span className={`text-[11px] font-semibold mt-0.5 shrink-0 ${decided ? 'text-gray-400 dark:text-gray-500' : 'text-amber-700 dark:text-amber-300'}`}>
            {index + 1}.
          </span>
          <div className="flex-1 min-w-0">
            <p className={`text-sm break-words ${clamped ? 'line-clamp-2' : ''} ${
              decided
                ? 'text-gray-500 dark:text-gray-400 line-through decoration-gray-400/60'
                : 'text-amber-900 dark:text-amber-200'
            }`}>
              {f.body}
            </p>
            {compact && (
              <button
                onClick={() => setExpandedFindings(prev => {
                  const next = new Set(prev);
                  if (next.has(noteKey)) next.delete(noteKey); else next.add(noteKey);
                  return next;
                })}
                className="text-[11px] text-amber-700/70 dark:text-amber-300/70 hover:text-amber-800 dark:hover:text-amber-200 underline"
              >
                {clamped ? 'Show more' : 'Show less'}
              </button>
            )}

            {dismissed && (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 italic">
                Ignored — won't be changed{f.note ? ` (${f.note})` : ''}
              </p>
            )}
            {resolved && (
              <p className="mt-1 text-[11px] text-green-700 dark:text-green-400 italic">
                Marked as already fixed
              </p>
            )}
            {inFlight && (
              <p className="mt-1 text-[11px] text-blue-600 dark:text-blue-400">Sent to the implementer</p>
            )}
            {claimedFixed && (
              <p className="mt-1 text-[11px] text-blue-600 dark:text-blue-400">
                Implementer reports this fixed — awaiting reviewer verification
                {f.note ? ` (${f.note})` : ''}
              </p>
            )}
            {verified && (
              <p className="mt-1 text-[11px] text-green-700 dark:text-green-400 italic">
                Fixed and verified by a later review
              </p>
            )}
            {f.revision > 0 && f.state === 'open' && (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                Re-raised — the reviewer judged the previous fix inadequate
              </p>
            )}
            {/* Why the implementer handed this back ("not_fixed"/"disagree").
                Without it the finding returns to the user stripped of the one
                piece of context that explains why it is theirs to decide. */}
            {f.state === 'open' && f.note && (
              <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400 italic">{f.note}</p>
            )}
            {!decided && supersededByLaterReview(f) && (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                A later review didn't raise this again — likely fixed, but not confirmed.
              </p>
            )}

            {noteOpen ? (
              <div className="mt-2 space-y-1.5">
                <input
                  autoFocus
                  value={dismissNote}
                  onChange={e => setDismissNote(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleDismissFinding(f, dismissNote); }
                    if (e.key === 'Escape') { setDismissNoteFor(null); setDismissNote(''); }
                  }}
                  placeholder="Why? (optional — the reviewer is shown this reason)"
                  className="w-full text-xs px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDismissFinding(f, dismissNote)}
                    disabled={busy}
                    className="text-[11px] font-medium px-2 py-1 rounded bg-gray-600 hover:bg-gray-700 text-white disabled:opacity-50"
                  >
                    {busy ? 'Dismissing…' : 'Confirm dismiss'}
                  </button>
                  <button
                    onClick={() => { setDismissNoteFor(null); setDismissNote(''); }}
                    className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1.5">
                {decided ? (
                  <button
                    onClick={() => handleReopenFinding(f)}
                    disabled={busy}
                    className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline disabled:opacity-50"
                  >
                    {busy ? 'Reopening…' : 'Undo'}
                  </button>
                ) : (
                  <>
                    {canAct && (
                      <button
                        onClick={() => handleFixFinding(f)}
                        disabled={busy || pendingFinding !== null || sending || applyingFixes}
                        className="text-[11px] font-medium px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
                      >
                        {busy ? 'Sending…' : 'Fix this'}
                      </button>
                    )}
                    <button
                      onClick={() => handleResolveFinding(f)}
                      disabled={busy || pendingFinding !== null}
                      className="text-[11px] font-medium px-2 py-1 rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50 transition-colors"
                    >
                      {busy ? 'Saving…' : 'Already fixed'}
                    </button>
                    <button
                      onClick={() => { setDismissNoteFor(noteKey); setDismissNote(''); }}
                      disabled={busy || pendingFinding !== null}
                      className="text-[11px] font-medium px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                    >
                      Ignore
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  /**
   * Every undecided finding across every reviewer turn, pinned just above the
   * composer. Fixing one finding spawns a new reviewer turn, which pushes the
   * findings you were working through far up the conversation — without this
   * you have to scroll back through earlier messages to act on the rest.
   * Collapsed by default, and when open it is capped at min(14rem, 20vh) with
   * its own scroll and two-line clamped bodies, so it never crowds out the
   * composer no matter how many findings accumulate. It was originally
   * expanded by default
   * at full body length, which on a task with several accumulated findings
   * filled the whole modal and pushed the conversation and composer out of
   * view. The header alone carries the signal; the detail is opt-in.
   */
  const renderUnresolvedFindingsPanel = () => {
    const unresolved = unresolvedFindings();
    if (unresolved.length === 0) return null;
    const allSuperseded = unresolved.every(supersededByLaterReview);

    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/20">
        <button
          onClick={() => setUnresolvedOpen(o => !o)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <svg className={`w-3 h-3 text-amber-700 dark:text-amber-300 transition-transform ${unresolvedOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
            {unresolved.length} review finding{unresolved.length === 1 ? '' : 's'} still undecided
          </span>
          {allSuperseded && (
            <span className="text-[11px] text-amber-700/70 dark:text-amber-300/70">
              — a later review passed without raising {unresolved.length === 1 ? 'it' : 'them'}
            </span>
          )}
        </button>
        {unresolvedOpen && (
          <div className="px-3 pb-3 space-y-2">
            <div className="max-h-[min(14rem,20vh)] overflow-y-auto space-y-2 pr-1">
              {unresolved.map((f, i) => renderFinding(f, i, true, 'unresolved', true))}
            </div>
            {unresolved.length > 1 && (
              <button
                onClick={() => handleFixFindings(unresolved, 'unresolved-panel')}
                disabled={pendingFinding !== null || sending || applyingFixes}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
              >
                {pendingFinding === 'unresolved-panel' ? 'Sending…' : `Fix all ${unresolved.length} remaining`}
              </button>
            )}
          </div>
        )}
      </div>
    );
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
    //
    // Actionability is per-finding, NOT per-turn. This used to require
    // `turn.id === latestReviewerTurnId` — a holdover from when a verdict was
    // one indivisible blob, so a newer verdict superseded the whole of an older
    // one. With individual findings that silently orphans them: fixing one
    // finding starts an implementer turn and then a *new* reviewer turn, which
    // made every still-open finding of the turn you were working through
    // permanently un-fixable (Ignore stayed, Fix vanished). A finding is stale
    // only once it has been decided, not because time passed.
    const canApply = task?.status === 'awaiting_feedback';
    const turnFindings = findingsForTurn(turn.id);
    const openCount = turnFindings.filter(f => f.state === 'open').length;
    const decidedCount = turnFindings.length - openCount;
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
          {turnFindings.length > 0 ? (
            <div className="space-y-2">
              {turnFindings.map((f, i) => renderFinding(f, i, canApply))}
            </div>
          ) : issues.length > 0 ? (
            // Legacy verdicts (recorded before per-finding triage) have no
            // finding rows, so fall back to the flat bullet list.
            <ul className="list-disc list-outside ml-4 space-y-1 text-sm text-amber-900 dark:text-amber-200">
              {issues.map((iss, i) => <li key={i}>{iss}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-amber-900 dark:text-amber-200">{turn.review_summary || 'The reviewer reported issues.'}</p>
          )}
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            {canApply && openCount > 1 && (
              <button
                onClick={() => handleFixAllOpen(turn.id)}
                disabled={pendingFinding !== null || sending || applyingFixes}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
              >
                {pendingFinding === turn.id ? 'Sending…' : `Fix all ${openCount} remaining`}
              </button>
            )}
            {canApply && turnFindings.length === 0 && (
              <button
                onClick={() => handleApplyFixes(turn)}
                disabled={applyingFixes || sending}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
              >
                {applyingFixes ? 'Applying…' : 'Apply suggested fixes'}
              </button>
            )}
            {decidedCount > 0 && (
              <span className="text-[11px] text-amber-700/70 dark:text-amber-300/70">
                {decidedCount} decided — later reviews are told about {decidedCount === 1 ? 'it' : 'them'}
              </span>
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
                  {/* Model is switchable mid-task: each turn is a fresh
                      `--resume` invocation and a session's transcript records the
                      model per message, so one conversation can span models.
                      Applies from the next turn — the running turn keeps its own.
                      Falls back to a static chip until the model list loads, so
                      the current model is never hidden. */}
                  {availableModels.length > 0 ? (
                    <select
                      value={task.model ?? ''}
                      onChange={(e) => handleChangeModel(e.target.value)}
                      disabled={switchingModel}
                      title="Model — applies from the next turn"
                      className={`hidden sm:inline-block text-xs px-1.5 py-0.5 rounded font-medium border-0 focus:outline-none focus:ring-1 disabled:opacity-50 cursor-pointer ${
                        task.model?.startsWith('ollama/')
                          ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 focus:ring-green-500'
                          : 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 focus:ring-purple-500'
                      }`}
                    >
                      <option value="">default model</option>
                      {(['anthropic', 'ollama-local', 'ollama-cloud'] as const)
                        .filter(p => availableModels.some(m => m.provider === p))
                        .map(p => (
                          <optgroup key={p} label={p === 'anthropic' ? 'Claude' : p === 'ollama-local' ? 'Ollama (local)' : 'Ollama (cloud)'}>
                            {availableModels.filter(m => m.provider === p).map(m => (
                              <option key={m.id} value={m.id}>{m.display_name}</option>
                            ))}
                          </optgroup>
                        ))}
                      {/* A model that is no longer offered (renamed, or an Ollama
                          model since removed) must stay selectable or the select
                          would silently jump to "default model". */}
                      {task.model && !availableModels.some(m => m.id === task.model) && (
                        <option value={task.model}>{task.model} (unavailable)</option>
                      )}
                    </select>
                  ) : task.model ? (
                    <span className={`hidden sm:inline-block text-xs px-1.5 py-0.5 rounded font-medium ${
                      task.model.startsWith('ollama/')
                        ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                        : 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
                    }`}>
                      {task.model.startsWith('ollama/')
                        ? task.model.slice('ollama/'.length).replace(/:latest$/, '')
                        : task.model.replace(/^claude-/, '')}
                    </span>
                  ) : null}
                  {/* Which Claude subscription this task burns. Editable mid-task:
                      the change lands on the next turn, so a rate-limited task can
                      be finished on the other subscription. Hidden for Ollama
                      models, which never reach Anthropic.

                      Also shown when the task is pinned to an account that no
                      longer exists, even with no accounts left — a pinned task
                      fails every turn until it is re-pointed, so this control has
                      to stay reachable to be the fix. That includes the case where
                      the account list failed to load: still render it for a pinned
                      task (so the escape hatch exists), but don't claim the account
                      was removed, because we don't know. */}
                  {accountsState !== 'loading'
                    && (claudeAccounts.length > 0 || task.claude_account_id)
                    // Suppressed for Ollama models, which never reach Anthropic —
                    // but NOT when the task is actually pinned to an account.
                    // Advisors stage the token regardless of the model, so a pinned
                    // Ollama task can still fail on a dead pin, and hiding the
                    // control would leave the failure message pointing at a control
                    // that isn't rendered.
                    && (!!task.claude_account_id || !task.model?.startsWith('ollama/'))
                    && (() => {
                    const pinnedId = task.claude_account_id;
                    const known = claudeAccounts.some(a => a.id === pinnedId);
                    // Only assert "removed" when the list actually loaded.
                    const isDangling = accountsState === 'loaded' && !!pinnedId && !known;
                    // Pinned, list unavailable — keep it usable without diagnosing.
                    const isUnverifiable = accountsState === 'failed' && !!pinnedId && !known;
                    const highlight = isDangling || isUnverifiable;
                    return (
                      <select
                        value={pinnedId ?? WORKSPACE_CLAUDE_ACCOUNT}
                        onChange={(e) => handleChangeClaudeAccount(e.target.value)}
                        disabled={switchingAccount}
                        title={isDangling
                          ? 'This subscription was removed — pick another or switch to the workspace login to make this task runnable again'
                          : isUnverifiable
                            ? 'Could not load your subscriptions. This task is pinned to one; switch it to the workspace login if turns are failing.'
                            : 'Claude subscription — applies from the next turn'}
                        // Stays visible on narrow screens whenever the pin needs
                        // attention: it is the only control that can make the task
                        // runnable again, so hiding it below sm would strand the
                        // task on a phone.
                        className={`text-xs px-1.5 py-0.5 rounded font-medium border-0 focus:outline-none focus:ring-1 disabled:opacity-50 cursor-pointer ${
                          isDangling
                            ? 'inline-block bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 focus:ring-red-500'
                            : isUnverifiable
                              ? 'inline-block bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 focus:ring-amber-500'
                              : 'hidden sm:inline-block bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500'
                        }`}
                      >
                        <option value={WORKSPACE_CLAUDE_ACCOUNT}>workspace login</option>
                        {claudeAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.label}</option>
                        ))}
                        {/* Keeps the select controlled (and the state visible)
                            rather than silently displaying the first option. */}
                        {highlight && (
                          <option value={pinnedId!}>
                            {isDangling ? 'subscription removed' : 'pinned subscription'}
                          </option>
                        )}
                      </select>
                    );
                  })()}
                  {/* Auto-review, switchable mid-task like the model and the
                      subscription. Applies from the next decision point: a
                      reviewer already running finishes, but its verdict no longer
                      bounces back to the implementer — unless it was started with
                      the Review button, which is exempt and still routes its
                      verdict back for one fix turn. Turning it back on resumes
                      reviewing from the next code-changing turn. */}
                  <select
                    value={task.auto_review ? 'on' : 'off'}
                    onChange={(e) => handleChangeAutoReview(e.target.value === 'on')}
                    disabled={switchingAutoReview}
                    title={task.auto_review
                      ? 'Auto-review is on — a reviewer red-teams each code-changing turn before it surfaces to you'
                      : 'Auto-review is off — turns surface to you without a review pass'}
                    className={`hidden sm:inline-block text-xs px-1.5 py-0.5 rounded font-medium border-0 focus:outline-none focus:ring-1 disabled:opacity-50 cursor-pointer ${
                      task.auto_review
                        ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 focus:ring-teal-500'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 focus:ring-gray-500'
                    }`}
                  >
                    <option value="on">auto-review on</option>
                    <option value="off">auto-review off</option>
                  </select>
                  {/* Reviewer model — only meaningful while auto-review is on, so
                      it stays hidden otherwise rather than adding a dead control
                      to an already-busy header. Defaults to "same as task", which
                      is the previous behaviour. A stronger reviewer is not simply
                      better: it raises more true-but-pedantic findings, and each
                      one costs a fix round. */}
                  {!!task.auto_review && availableModels.length > 0 && (
                    <select
                      value={task.reviewer_model ?? ''}
                      onChange={(e) => handleChangeReviewerModel(e.target.value)}
                      disabled={switchingReviewerModel}
                      title={task.reviewer_model
                        ? `Reviewer runs on ${task.reviewer_model} — applies from the next review pass`
                        : 'Reviewer runs on the same model as the task — applies from the next review pass'}
                      className={`hidden sm:inline-block text-xs px-1.5 py-0.5 rounded font-medium border-0 focus:outline-none focus:ring-1 disabled:opacity-50 cursor-pointer ${
                        task.reviewer_model
                          ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 focus:ring-teal-500'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 focus:ring-gray-500'
                      }`}
                    >
                      <option value="">reviewer: same as task</option>
                      {(['anthropic', 'ollama-local', 'ollama-cloud'] as const)
                        .filter(p => availableModels.some(m => m.provider === p))
                        .map(p => (
                          <optgroup key={p} label={p === 'anthropic' ? 'Claude' : p === 'ollama-local' ? 'Ollama (local)' : 'Ollama (cloud)'}>
                            {availableModels.filter(m => m.provider === p).map(m => (
                              <option key={m.id} value={m.id}>reviewer: {m.display_name}</option>
                            ))}
                          </optgroup>
                        ))}
                      {/* Same reasoning as the task model select: a pinned model
                          that is no longer offered must stay selectable, or the
                          control would silently reset itself to "same as task". */}
                      {task.reviewer_model && !availableModels.some(m => m.id === task.reviewer_model) && (
                        <option value={task.reviewer_model}>reviewer: {task.reviewer_model} (unavailable)</option>
                      )}
                    </select>
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
                // Attachments tied to a message render inline with it, right
                // under the bubble — see the AttachmentPill usage below.
                const attachmentsByMessage = new Map<string, AttachmentInfo[]>();
                for (const att of attachments) {
                  if (!att.message_id) continue;
                  const arr = attachmentsByMessage.get(att.message_id);
                  if (arr) arr.push(att); else attachmentsByMessage.set(att.message_id, [att]);
                }
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

                  const msgAttachments = attachmentsByMessage.get(msg.id);
                  // Files that render as their own thumbnail below don't also
                  // need the "Generated file: …" line in the prose.
                  const previewedNames = new Set(
                    (msgAttachments ?? []).filter(isPreviewableImage).map(a => a.original_name)
                  );

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
                    <Markdown content={msg.role === 'assistant' ? collapseWakeBlocks(collapseOutputFileBlocks(collapseTaskRequestBlocks(msg.content), previewedNames)) : msg.content} breaks={msg.role === 'user'} />
                    {msgAttachments?.length ? <AttachmentGroup attachments={msgAttachments} /> : null}
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

              {/* Fallback only — every new attachment is tied to the message that
                  uploaded/produced it and renders inline with it above. This
                  catches legacy attachments from before that link existed. */}
              {attachments.some(a => !a.message_id) && (
                <div className="px-1">
                  <AttachmentGroup attachments={attachments.filter(a => !a.message_id)} />
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
                  {renderUnresolvedFindingsPanel()}
                  {task.wake_at && (
                    <div className="text-xs px-3 py-2 rounded-md bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300">
                      <div className="flex items-start gap-2">
                        <span className="shrink-0">⏰</span>
                        <div className="flex-1 min-w-0">
                          <div>
                            <span className="font-medium">The agent will pick this up again on its own {timeUntil(task.wake_at)}</span>
                            {task.wake_file && <> — or sooner, as soon as <code className="text-[11px]">{task.wake_file}</code> appears.</>}
                          </div>
                          {task.wake_note && <div className="mt-0.5 opacity-80">{task.wake_note}</div>}
                          <div className="mt-1.5 flex gap-3">
                            <button
                              onClick={handleWakeNow}
                              disabled={wakeBusy}
                              className="underline hover:no-underline disabled:opacity-50"
                            >
                              Check now
                            </button>
                            <button
                              onClick={handleCancelWake}
                              disabled={wakeBusy}
                              className="underline hover:no-underline disabled:opacity-50"
                            >
                              Cancel wake-up
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
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
                        <MarkdownComposer
                          ref={composerRef}
                          accent="teal"
                          value={reply}
                          onChange={handleReplyChange}
                          onCaretMove={handleReplyCaretMove}
                          onKeyDown={handleParticipantReplyKeyDown}
                          placeholder={anyParticipantRunning
                            ? 'Advisor is thinking...'
                            : `${`Ask ${participants.find(p => p.id === targetParticipantId)?.workspace_name || 'advisor'}...`}${participants.length > 0 ? ' (type @ to mention)' : ''}`}
                          autoFocus
                          disabled={sending || anyParticipantRunning}
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
                        <MarkdownComposer
                          ref={composerRef}
                          value={reply}
                          onChange={handleReplyChange}
                          onCaretMove={handleReplyCaretMove}
                          onKeyDown={handleReplyKeyDown}
                          placeholder={anyParticipantRunning
                            ? 'Advisor is thinking...'
                            : participants.length > 0
                              ? 'Reply with feedback... (type @ to mention)'
                              : 'Reply with feedback...'}
                          autoFocus
                          disabled={anyParticipantRunning}
                        />
                        {mentionDropdown}
                      </div>
                      <PendingFiles files={pendingFiles} onRemove={handleRemovePendingFile} />
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
                    {/* Manually trigger the red-team reviewer. Hidden when this
                        task has no worktree (nothing to review). */}
                    {!!task.worktree_path && (
                      <button
                        onClick={handleReview}
                        disabled={reviewing || completing || !!task.pending_complete}
                        className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-md border border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50"
                        title="Run the red-team reviewer on this task's changes"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>
                        {reviewing ? 'Starting review…' : 'Review'}
                      </button>
                    )}
                    <ContextMeter
                      tokens={task.context_tokens ?? 0}
                      onCompact={handleCompactSession}
                      compacting={compactingSession}
                    />
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
                  ) : task.failed_reason === 'git_error' ? (
                    <div className="space-y-2">
                      <div className="text-sm text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-900/20 border border-orange-300 dark:border-orange-700 p-3 rounded-md">
                        <div className="font-medium mb-1">Git operation failed</div>
                        <div className="text-xs">
                          The git operations failed when completing this task — see the conversation above for details.
                          Ask the agent to resolve the issues (completion then runs automatically), or fix them manually and retry completion.
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={handleResolveGitIssues}
                          disabled={resolvingGitIssues || sending}
                          className="bg-orange-600 text-white text-sm px-4 py-2 rounded-md hover:bg-orange-700 disabled:opacity-50 transition-colors"
                        >
                          {resolvingGitIssues ? 'Asking agent…' : 'Resolve git issues & complete'}
                        </button>
                        <button
                          onClick={handleComplete}
                          disabled={completing}
                          className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-2 disabled:opacity-50"
                          title="Retry the completion step — use this after manually resolving git issues"
                        >
                          {completing ? 'Retrying…' : 'Retry completion'}
                        </button>
                      </div>
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
