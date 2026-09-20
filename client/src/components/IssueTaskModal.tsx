import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getWorkspaceIssues,
  getWorkspaceIssue,
  createTask,
  type GitHubIssueSummary,
  type GitHubIssueDetail,
  type GitHubRepoRef,
  type ClaudeAccount,
  type ModelInfo,
} from '../api/client';
import Markdown from './Markdown';
import MarkdownComposer from './MarkdownComposer';

/** Sentinel meaning "use the target workspace's own `claude login`". */
const WORKSPACE_CLAUDE_ACCOUNT = 'workspace';

/**
 * Create a task from a GitHub issue.
 *
 * Three panes on desktop: the repo's open issues, the selected issue's body and
 * comment thread, and a composer for what you actually want done. The task's
 * prompt is assembled server-side (the issue text is fetched there, not pasted
 * from here) and the task is linked to the issue, so marking the task complete
 * closes the issue and reopening the task reopens it.
 */
export default function IssueTaskModal({
  workspaceId,
  workspaceName,
  models,
  loadingModels,
  claudeAccounts,
  accountsLoaded,
  model,
  onModelChange,
  claudeAccount,
  onClaudeAccountChange,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  workspaceName: string;
  models: ModelInfo[];
  loadingModels: boolean;
  claudeAccounts: ClaudeAccount[];
  accountsLoaded: boolean;
  /**
   * Model and subscription are owned by the page, not this modal: they're
   * resolved asynchronously (per-workspace localStorage defaults + the account
   * list) after the modal has already mounted, so a copy taken at mount time
   * would always be the empty pre-resolution value.
   */
  model: string;
  onModelChange: (value: string) => void;
  claudeAccount: string;
  onClaudeAccountChange: (value: string) => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [repo, setRepo] = useState<GitHubRepoRef | null>(null);
  const [issues, setIssues] = useState<GitHubIssueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<GitHubIssueDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [description, setDescription] = useState('');
  const [includeComments, setIncludeComments] = useState(true);
  const [autoReview, setAutoReview] = useState(false);
  const [creating, setCreating] = useState(false);

  // Cache fetched issue bodies so flipping between issues in the list doesn't
  // re-hit the API (and GitHub's rate limit) for one already read.
  const detailCache = useRef(new Map<number, GitHubIssueDetail>());
  // Reading pane, so picking another issue starts at its title rather than
  // wherever the previous (possibly very long) one was scrolled to.
  const readingPaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getWorkspaceIssues(workspaceId)
      .then(({ repo, issues }) => {
        if (cancelled) return;
        setRepo(repo);
        setIssues(issues);
        if (!repo) setError('This workspace is not checked out on a GitHub repository.');
      })
      .catch(err => !cancelled && setError(err.message || 'Failed to load issues'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    if (selected === null) return;
    if (readingPaneRef.current) readingPaneRef.current.scrollTop = 0;
    const cached = detailCache.current.get(selected);
    if (cached) {
      setDetail(cached);
      setDetailError('');
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetail(null);
    setDetailError('');
    getWorkspaceIssue(workspaceId, selected)
      .then(({ issue }) => {
        if (cancelled) return;
        detailCache.current.set(issue.number, issue);
        setDetail(issue);
      })
      .catch(err => !cancelled && setDetailError(err.message || 'Failed to load issue'))
      .finally(() => !cancelled && setLoadingDetail(false));
    return () => { cancelled = true; };
  }, [workspaceId, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter(i =>
      i.title.toLowerCase().includes(q) ||
      String(i.number).includes(q) ||
      i.labels.some(l => l.toLowerCase().includes(q)),
    );
  }, [issues, filter]);

  const handleCreate = async () => {
    if (selected === null || !description.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      await createTask(workspaceId, description.trim(), {
        issueNumber: selected,
        includeIssueComments: includeComments,
        model: model || undefined,
        autoReview,
        claudeAccountId: accountsLoaded ? claudeAccount || undefined : undefined,
      });
      onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 w-full h-full sm:h-[85vh] sm:max-w-6xl sm:rounded-lg shadow-xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">New task from a GitHub issue</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {workspaceName}
              {repo && (
                <>
                  {' · '}
                  <a href={repo.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                    {repo.owner}/{repo.repo}
                  </a>
                </>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-3 text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-3 py-2 rounded shrink-0">
            {error}
          </div>
        )}

        <div className="flex-1 flex flex-col lg:flex-row min-h-0">
          {/* Issue list */}
          <div className="lg:w-72 xl:w-80 shrink-0 border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-800 flex flex-col min-h-0 max-h-52 lg:max-h-none">
            <div className="p-2 shrink-0">
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter issues…"
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1 min-h-0">
              {loading ? (
                <p className="text-xs text-gray-500 dark:text-gray-400 px-1 py-2">Loading issues…</p>
              ) : filtered.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-gray-400 px-1 py-2">
                  {issues.length === 0 ? 'No open issues.' : 'No issues match that filter.'}
                </p>
              ) : (
                filtered.map(issue => (
                  <button
                    key={issue.number}
                    onClick={() => setSelected(issue.number)}
                    className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${
                      selected === issue.number
                        ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700'
                        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600'
                    }`}
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">#{issue.number}</span>
                      <span className="text-sm text-gray-900 dark:text-gray-100 line-clamp-2">{issue.title}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      {issue.labels.slice(0, 3).map(l => (
                        <span key={l} className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          {l}
                        </span>
                      ))}
                      {issue.comments > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] text-gray-400 dark:text-gray-500"
                          title={`${issue.comments} comment${issue.comments === 1 ? '' : 's'}`}
                        >
                          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 16 16"><path d="M2.5 2h11a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13.5 12H7.9l-3.2 2.7A.5.5 0 0 1 4 14.3V12H2.5A1.5 1.5 0 0 1 1 10.5v-7A1.5 1.5 0 0 1 2.5 2Z" /></svg>
                          {issue.comments}
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Issue body + comments */}
          <div ref={readingPaneRef} className="flex-1 overflow-y-auto p-4 min-h-0 min-w-0">
            {selected === null ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Pick an issue on the left to read it and base a task on it.
              </p>
            ) : loadingDetail ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading issue…</p>
            ) : detailError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{detailError}</p>
            ) : detail ? (
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {detail.title}{' '}
                  <span className="text-gray-400 dark:text-gray-500 font-normal">#{detail.number}</span>
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  opened by {detail.user ?? 'unknown'} on {detail.created_at.slice(0, 10)}
                  {' · '}
                  <a href={detail.html_url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                    view on GitHub
                  </a>
                </p>
                <div className="mt-3 border-t border-gray-200 dark:border-gray-800 pt-3">
                  {detail.body.trim() ? (
                    <Markdown content={detail.body} />
                  ) : (
                    <p className="text-sm text-gray-400 dark:text-gray-500 italic">No description.</p>
                  )}
                </div>
                {detail.comment_list.length > 0 && (
                  <div className="mt-4 space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {detail.comment_list.length} comment{detail.comment_list.length === 1 ? '' : 's'}
                    </h4>
                    {detail.comment_list.map(c => (
                      <div key={c.id} className="border border-gray-200 dark:border-gray-800 rounded p-3">
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                          <span className="font-medium text-gray-700 dark:text-gray-300">{c.user ?? 'unknown'}</span>
                          {' · '}{c.created_at.slice(0, 10)}
                        </p>
                        <Markdown content={c.body || '_(empty)_'} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* Composer */}
          <div className="lg:w-80 xl:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-gray-200 dark:border-gray-800 flex flex-col min-h-0">
            <div className="p-3 overflow-y-auto space-y-2 min-h-0">
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                What should Claude do?
              </label>
              <MarkdownComposer
                size="compact"
                value={description}
                onChange={v => setDescription(v)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
                placeholder={selected === null ? 'Select an issue first…' : 'e.g. Fix this and add a regression test.'}
                disabled={creating || selected === null}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The issue's title, link and body are prepended to this automatically.
              </p>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeComments}
                  onChange={e => setIncludeComments(e.target.checked)}
                  disabled={creating}
                  className="w-3.5 h-3.5 accent-blue-600"
                />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  Include the comment thread in the prompt
                </span>
              </label>

              <select
                value={model}
                onChange={e => onModelChange(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                disabled={creating || loadingModels}
              >
                <option value="">{loadingModels ? 'Loading models...' : 'Default model'}</option>
                {models.some(m => m.provider === 'anthropic') && (
                  <optgroup label="Claude">
                    {models.filter(m => m.provider === 'anthropic').map(m => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                )}
                {models.some(m => m.provider === 'ollama-local') && (
                  <optgroup label="Ollama (local)">
                    {models.filter(m => m.provider === 'ollama-local').map(m => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                )}
                {models.some(m => m.provider === 'ollama-cloud') && (
                  <optgroup label="Ollama (cloud)">
                    {models.filter(m => m.provider === 'ollama-cloud').map(m => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                )}
              </select>

              {accountsLoaded && claudeAccounts.length > 0 && (
                <select
                  value={claudeAccount}
                  onChange={e => onClaudeAccountChange(e.target.value)}
                  className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  disabled={creating}
                  title="Which Claude subscription this task runs on"
                >
                  <option value={WORKSPACE_CLAUDE_ACCOUNT}>Subscription: workspace's own login</option>
                  {claudeAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      Subscription: {a.label}{a.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              )}

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoReview}
                  onChange={e => setAutoReview(e.target.checked)}
                  disabled={creating}
                  className="w-3.5 h-3.5 accent-blue-600"
                />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  Auto-review — red-team pass before surfacing to you
                </span>
              </label>

              <p className="text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-800 pt-2">
                Marking this task complete will close {selected !== null ? `issue #${selected}` : 'the chosen issue'} on
                GitHub. Reopening the task reopens it.
              </p>
            </div>

            <div className="mt-auto p-3 border-t border-gray-200 dark:border-gray-800 flex gap-2 shrink-0">
              <button
                onClick={handleCreate}
                disabled={creating || selected === null || !description.trim()}
                className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create task'}
              </button>
              <button
                onClick={onClose}
                className="text-sm px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
