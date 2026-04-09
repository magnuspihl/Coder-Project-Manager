import { useState, useEffect, useRef, type FormEvent } from 'react';
import {
  getDiscussionDetail,
  sendDiscussionMessage,
  closeDiscussion,
  approveTaskRequest,
  dismissTaskRequest,
  type Discussion,
  type DiscussionMessage,
  type TaskRequestItem,
} from '../api/client';
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

interface DiscussionModalProps {
  discussionId: string;
  workspaceName: string;
  onClose: () => void;
  onTaskCreated?: () => void;
}

export default function DiscussionModal({ discussionId, workspaceName, onClose, onTaskCreated }: DiscussionModalProps) {
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [taskRequests, setTaskRequests] = useState<TaskRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage, clearMessage] = useDraft(`discussion:${discussionId}`);
  const [sending, setSending] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  const loadData = async () => {
    try {
      const data = await getDiscussionDetail(discussionId);
      setDiscussion(data.discussion);
      setMessages(data.messages);
      setTaskRequests(data.taskRequests);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const poll = async () => { await loadData(); };
    poll();
    const pollMs = discussion?.running ? 3000 : 10000;
    const interval = setInterval(poll, pollMs);
    return () => clearInterval(interval);
  }, [discussionId, discussion?.running]);

  // Scroll to bottom
  useEffect(() => {
    if (!loading && scrollBodyRef.current) {
      const el = scrollBodyRef.current;
      if (!initialScrollDone.current) {
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        initialScrollDone.current = true;
      } else {
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
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
    try {
      await sendDiscussionMessage(discussionId, message.trim());
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
    await approveTaskRequest(discussionId, requestId);
    onTaskCreated?.();
    await loadData();
  };

  const handleDismiss = async (requestId: string) => {
    await dismissTaskRequest(discussionId, requestId);
    await loadData();
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
                  {discussion.running && discussion.activity && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      Last activity {timeAgo(discussion.activity.timestamp)}
                    </span>
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
              {messages.length === 0 && !discussion.running && (
                <div className="text-center text-gray-400 dark:text-gray-500 text-sm py-8">
                  Start a conversation about this workspace. Claude can read code but won't modify anything.
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-lg p-4 ${
                    msg.role === 'user'
                      ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 ml-8'
                      : msg.role === 'assistant'
                      ? 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 mr-8'
                      : 'bg-purple-50 dark:bg-purple-900/20 border border-purple-100 dark:border-purple-800 text-purple-700 dark:text-purple-400 text-sm'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      {msg.role === 'user' && msg.username ? msg.username : msg.role}
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
                  {msg.role === 'assistant' ? (
                    <Markdown content={msg.content} />
                  ) : (
                    <div className="text-sm whitespace-pre-wrap">{linkify(msg.content)}</div>
                  )}
                </div>
              ))}

              {/* Working indicator */}
              {discussion.running && (
                <div className="text-sm text-purple-600 dark:text-purple-400 p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-100 dark:border-purple-800">
                  <div className="flex items-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-purple-600 dark:border-purple-400 border-t-transparent rounded-full" />
                    <span>Claude is thinking...</span>
                    {discussion.activity && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                        {timeAgo(discussion.activity.timestamp)}
                      </span>
                    )}
                  </div>
                  {discussion.activity && (
                    <p className="mt-1 text-xs text-purple-500 dark:text-purple-300 truncate ml-6">
                      {linkify(discussion.activity.summary)}
                    </p>
                  )}
                </div>
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
                      className="text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700"
                    >
                      Create Task
                    </button>
                    <button
                      onClick={() => handleDismiss(tr.id)}
                      className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer: message input + actions */}
            <div className="border-t border-gray-200 dark:border-gray-800 p-5">
              <form onSubmit={handleSend} className="flex flex-col gap-2">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={discussion.running ? 'Claude is thinking...' : 'Ask about the codebase...'}
                  rows={3}
                  autoFocus
                  disabled={sending || discussion.running}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-y disabled:opacity-50"
                />
                <div className="flex items-center justify-between">
                  <button
                    onClick={handleClose}
                    className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                  >
                    End Discussion
                  </button>
                  <button
                    type="submit"
                    disabled={sending || !message.trim() || discussion.running}
                    className="bg-purple-600 text-white text-sm px-4 py-2 rounded-md hover:bg-purple-700 disabled:opacity-50"
                  >
                    {sending ? 'Sending...' : 'Send (Ctrl+Enter)'}
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
