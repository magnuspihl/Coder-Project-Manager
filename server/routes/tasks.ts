import { Router, Request, Response } from 'express';
import { requireAuth, requireTaskAccess } from '../middleware/auth.js';
import { getAccount } from '../services/claude-accounts.js';

/** Sentinel meaning "use the target workspace's own `claude login`, not a CPM account". */
const WORKSPACE_CLAUDE_ACCOUNT = 'workspace';
import {
  listTasks,
  getTask,
  createTask,
  updateTaskStatus,
  updateTaskPosition,
  updateTaskTitle,
  deleteTask,
  restoreTask,
  addMessage,
  getMessages,
  getMessageCount,
  getTaskCostUsd,
  getTaskCostsByWorkspace,
  getWorkingTask,
  getWorkingTaskCount,
  getMaxConcurrent,
  setPendingComplete,
  setTaskAutoReview,
  setTaskClaudeAccount,
  setTaskModel,
  resetTaskSession,
  addTaskParticipant,
  removeTaskParticipant,
  getTaskParticipants,
  getTaskParticipant,
  getTaskTurns,
  resetReviewLoopCount,
  getTaskRequest,
  getPendingTaskRequestsForTask,
  approveTaskRequest,
  dismissTaskRequest,
  setTaskRequestTarget,
  getReviewFindings,
  getReviewFinding,
  setReviewFindingState,
  getDismissedFindings,
  findingRef,
  REVIEW_FIX_REPLY_PREFIX,
} from '../services/tasks.js';
import { findUserWorkspaceById } from '../services/workspace-cache.js';
import { processQueue, cancelTask, interruptTask, getTaskActivity, getRateLimitInfo, getTaskStreamLog, getTaskStreamLogAfter, launchTaskParticipant, isTaskParticipantRunning, getTaskParticipantActivity, stopTaskParticipant, cleanupPortRange, triggerTaskHostCatchUp, triggerTaskParticipantCatchUp, withWorkspaceLock, triggerManualReview, FINDING_REPORT_FORMAT } from '../services/claude.js';
import { getWorkspace, CoderAuthError } from '../services/coder.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { handleTaskCompletionGit, handleTaskReopenGit, checkoutTaskBranch, removeTaskWorktree } from '../services/git.js';
import { linkAttachmentsToTask, getAttachmentsByTask } from './uploads.js';
import { getDb } from '../db/index.js';

const router = Router();

// Fire-and-forget for remote work (SSH round-trips) whose outcome the HTTP
// response doesn't depend on. Every coder-ssh call costs a fresh CLI spawn and
// connection handshake (~300-400ms each, more when cold), so awaiting cleanup
// or queue advancement inline made simple actions take seconds. Failures here
// are recovered elsewhere: the worktree reconciler sweeps deleted tasks that
// still have a worktree, the port janitor reaps orphaned dev servers, and
// launch errors inside processQueue mark the task failed with a message.
function runInBackground(label: string, fn: () => Promise<void>): void {
  fn().catch((err) =>
    console.error(`[tasks] background ${label} failed: ${(err as Error)?.message?.slice(0, 200)}`),
  );
}

// Per-resource authorization for every task-scoped route (`/tasks/:taskId...`).
// Runs after auth so req.user is set; denies access to tasks the caller doesn't
// own (identical 404 for missing vs. not-owned). Individual routes keep their
// own requireAuth — this only adds the ownership gate.
router.use('/tasks/:taskId', requireAuth, requireTaskAccess);

// List tasks for a workspace
router.get('/workspaces/:workspaceId/tasks', requireAuth, (req: Request, res: Response) => {
  const costs = getTaskCostsByWorkspace(req.params.workspaceId);
  const tasks = listTasks(req.params.workspaceId, req.user!.id).map(t => ({
    ...t,
    activity: t.status === 'working' ? getTaskActivity(t.id) || null : null,
    total_cost_usd: costs[t.id] || 0,
    rate_limit: getRateLimitInfo(t.id) || null,
  }));
  res.json({ tasks });
});

// Create a new task
router.post('/workspaces/:workspaceId/tasks', requireAuth, async (req: Request, res: Response) => {
  const { prompt, model, claudeAccountId, caveman, attachmentIds, autoReview } = req.body;
  if (!prompt) {
    res.status(400).json({ error: 'Prompt is required' });
    return;
  }

  // Which Claude subscription to run on. An explicit id pins that account (only
  // the caller's own — accounts are never shared); WORKSPACE_CLAUDE_ACCOUNT pins
  // the workspace's own `claude login`. Left `undefined` when the field is absent
  // so createTask applies the caller's default account, the same way MCP and
  // task-request approval get it.
  let requestedAccountId: string | null | undefined;
  if (claudeAccountId === undefined) {
    requestedAccountId = undefined;
  } else if (typeof claudeAccountId !== 'string' || claudeAccountId === '' || claudeAccountId === WORKSPACE_CLAUDE_ACCOUNT) {
    requestedAccountId = null;
  } else if (!getAccount(claudeAccountId, req.user!.id)) {
    res.status(404).json({ error: 'Unknown claudeAccountId' });
    return;
  } else {
    requestedAccountId = claudeAccountId;
  }

  // Fetch workspace name, with token refresh on auth failure
  let token = req.session!.coder_access_token;
  let workspace;
  try {
    workspace = await getWorkspace(token, req.params.workspaceId);
  } catch (err) {
    if (err instanceof CoderAuthError && req.session!.coder_refresh_token) {
      const newToken = await refreshAccessToken(req.session!);
      if (newToken) {
        token = newToken;
        req.session!.coder_access_token = newToken;
        try {
          workspace = await getWorkspace(newToken, req.params.workspaceId);
        } catch {
          // fall through
        }
      }
    }
    if (!workspace) {
      if (err instanceof CoderAuthError) {
        deleteSession(req.session!.id);
        res.clearCookie('session_id');
        res.status(401).json({ error: 'Coder token expired. Please log in again.' });
        return;
      }
      res.status(500).json({ error: 'Failed to create task' });
      return;
    }
  }

  try {
    const task = createTask({
      workspaceId: req.params.workspaceId,
      workspaceName: workspace.name,
      userId: req.user!.id,
      username: req.user!.username,
      prompt,
      model: typeof model === 'string' ? model.trim() : undefined,
      claudeAccountId: requestedAccountId,
      caveman: typeof caveman === 'string' && ['lite', 'full', 'ultra'].includes(caveman) ? caveman : undefined,
      source: req.authSource,
      clientLabel: req.clientLabel,
      autoReview: autoReview === false ? false : true,
    });

    if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
      linkAttachmentsToTask(attachmentIds.filter((id: unknown) => typeof id === 'string'), task.id);
    }

    // Respond as soon as the task row exists — launching it involves SSH
    // round-trips (worktree creation, spawning Claude) that the client observes
    // via polling anyway; launch failures mark the task failed with a message.
    res.status(201).json({ task: getTask(task.id) });
    runInBackground(`launch ${task.id}`, () => processQueue(req.params.workspaceId));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Get task details with messages (stream log loaded separately)
// Supports ?limit=N&offset=M for message pagination
router.get('/tasks/:taskId', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
  const messages = getMessages(req.params.taskId, limit, offset);
  const totalMessages = limit ? getMessageCount(req.params.taskId) : messages.length;
  const activity = task.status === 'working' ? getTaskActivity(task.id) || null : null;
  const totalCostUsd = getTaskCostUsd(task.id);
  const rateLimit = getRateLimitInfo(task.id) || null;
  const participants = getTaskParticipants(task.id).map(p => ({
    ...p,
    running: isTaskParticipantRunning(p.id),
    activity: getTaskParticipantActivity(p.id) || null,
  }));
  const attachments = getAttachmentsByTask(task.id);
  const turns = getTaskTurns(task.id);
  const taskRequests = getPendingTaskRequestsForTask(task.id);
  const findings = getReviewFindings(task.id);
  res.json({ task: { ...task, activity, total_cost_usd: totalCostUsd, rate_limit: rateLimit }, messages, totalMessages, participants, attachments, turns, taskRequests, findings });
});

// Get stream log for a task (loaded on demand)
router.get('/tasks/:taskId/stream-log', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  // Support incremental loading: ?after=<id> returns only newer entries
  const afterId = req.query.after ? parseInt(req.query.after as string, 10) : 0;
  const streamLog = afterId > 0
    ? getTaskStreamLogAfter(task.id, afterId)
    : getTaskStreamLog(task.id);
  res.json({ streamLog });
});

// Update task (reorder, edit prompt)
router.put('/tasks/:taskId', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  // Validate every field BEFORE writing any of them. Interleaving validation with
  // writes let a request with one good field and one bad field return an error
  // having already committed the good one — a partial update the caller has no way
  // to detect from the 4xx response.
  let newTitle: string | undefined;
  if (req.body.title !== undefined) {
    if (typeof req.body.title !== 'string') {
      res.status(400).json({ error: 'Title must be a string' });
      return;
    }
    const trimmed = req.body.title.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'Title cannot be empty' });
      return;
    }
    if (trimmed.length > 200) {
      res.status(400).json({ error: 'Title must be 200 characters or fewer' });
      return;
    }
    newTitle = trimmed;
  }

  // Switch the model mid-task. Takes effect on the next turn for the same reason
  // the subscription switch does: each turn is a fresh `--resume` invocation and a
  // session's transcript stores the model per message, so one conversation can
  // span models.
  let newModel: string | null | undefined;
  if (req.body.model !== undefined) {
    const value = req.body.model;
    // Trim before every check so a whitespace-only value normalises to NULL (one
    // representation of "default") rather than being stored as '', and so a long
    // padded string isn't rejected for a length it doesn't really have.
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed === null || trimmed === '') {
      newModel = null;
    } else if (typeof trimmed !== 'string' || trimmed.length > 120) {
      res.status(400).json({ error: 'model must be a string of 120 characters or fewer' });
      return;
    } else {
      newModel = trimmed;
    }
  }

  // Re-point the task at a different Claude subscription. Takes effect on the
  // next turn (resume, reviewer, or advisor) — the currently running process
  // keeps the token it launched with. This is the escape hatch for "this
  // subscription is rate-limited, finish the task on the other one".
  let newAccountId: string | null | undefined;
  if (req.body.claudeAccountId !== undefined) {
    const value = req.body.claudeAccountId;
    if (value === null || value === '' || value === WORKSPACE_CLAUDE_ACCOUNT) {
      newAccountId = null;
    } else if (typeof value !== 'string' || !getAccount(value, task.user_id)) {
      // Scoped to the task's owner, not the caller: the token is staged under the
      // owner's identity at launch, so pinning an account the owner doesn't have
      // would only fail later.
      res.status(404).json({ error: 'Unknown claudeAccountId' });
      return;
    } else {
      newAccountId = value;
    }
  }

  // Turn the reviewer on or off for the rest of this conversation. Same "applies
  // from the next decision" contract as model/subscription: a reviewer already
  // running finishes, but its verdict no longer bounces back to the implementer,
  // and no further turn launches one.
  let newAutoReview: boolean | undefined;
  if (req.body.autoReview !== undefined) {
    if (typeof req.body.autoReview !== 'boolean') {
      res.status(400).json({ error: 'autoReview must be a boolean' });
      return;
    }
    newAutoReview = req.body.autoReview;
  }

  if (req.body.position !== undefined) {
    updateTaskPosition(task.id, req.body.position);
  }
  if (newTitle !== undefined) updateTaskTitle(task.id, newTitle);
  if (newModel !== undefined) setTaskModel(task.id, newModel);
  if (newAccountId !== undefined) setTaskClaudeAccount(task.id, newAccountId);
  if (newAutoReview !== undefined && newAutoReview !== !!task.auto_review) {
    setTaskAutoReview(task.id, newAutoReview);
    // Logged to the conversation, unlike model/subscription switches: this one
    // changes what happens when the current turn ends, so "why did the reviewer
    // stop running?" needs an answer in the transcript.
    addMessage(
      task.id,
      'system',
      newAutoReview
        ? 'Auto-review enabled — the reviewer will run after the next code-changing turn.'
        : 'Auto-review disabled for this task — turns will surface to you without a review pass.',
      undefined, undefined, undefined, req.authSource, req.clientLabel,
    );
    // A disabled task must not carry a stale loop count into a later re-enable:
    // it would start partway to the escalation limit.
    if (!newAutoReview) resetReviewLoopCount(task.id);
  }

  res.json({ task: getTask(task.id) });
});

// Reply to a task (resume Claude session)
router.post('/tasks/:taskId/reply', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const isGitError = task.status === 'failed' && task.failed_reason === 'git_error';
  if (task.status !== 'awaiting_feedback' && !isGitError) {
    res.status(400).json({ error: 'Task is not awaiting feedback' });
    return;
  }

  const { message, attachmentIds, completeAfter } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  addMessage(task.id, 'user', message, undefined, req.user!.username, undefined, req.authSource, req.clientLabel);

  // User reply resets the review loop so the next implementer turn gets a fresh review
  resetReviewLoopCount(task.id);

  // `completeAfter` (used by "resolve git issues & complete"): finalize the task
  // automatically once this turn lands in awaiting_feedback. The pending_complete
  // flush in processQueue is guarded on that status, so it waits for the agent to
  // finish before running git completion — and does so under the workspace lock,
  // right after the fix, so another task can't advance origin/<default> in between.
  // When not requested, a reply means "keep working", so cancel any pending completion.
  if (completeAfter === true) {
    setPendingComplete(task.id, true);
  } else if (task.pending_complete) {
    setPendingComplete(task.id, false);
    addMessage(task.id, 'system', 'Pending completion cancelled — reply received.', undefined, undefined, undefined, req.authSource, req.clientLabel);
  }

  if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
    linkAttachmentsToTask(attachmentIds.filter((a: unknown) => typeof a === 'string'), task.id);
  }

  // Queue and let processQueue handle concurrency — it will resume immediately
  // if a slot is available, or hold in queue until one opens up. Backgrounded:
  // the client polls the queued→working transition anyway.
  updateTaskStatus(task.id, 'queued');
  res.json({ task: getTask(task.id) });
  runInBackground(`reply-launch ${task.id}`, () => processQueue(task.workspace_id));
});

// Triage a single reviewer finding. 'dismissed' is the load-bearing state: the
// reviewer starts a fresh session every pass and only ever saw the original
// prompt, so dismissed findings are replayed into later reviewer prompts as a
// waiver list. Without that it re-raises the same issue indefinitely.
router.patch('/tasks/:taskId/findings/:findingId', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const finding = getReviewFinding(req.params.findingId);
  // Scope by task as well as id — a finding id from another task must not be
  // mutable through this task's (already access-checked) route.
  if (!finding || finding.task_id !== task.id) {
    res.status(404).json({ error: 'Finding not found' });
    return;
  }

  const { state, note } = req.body;
  if (state !== 'open' && state !== 'dismissed' && state !== 'resolved') {
    res.status(400).json({ error: "state must be 'open', 'dismissed' or 'resolved'" });
    return;
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    res.status(400).json({ error: 'note must be a string' });
    return;
  }

  setReviewFindingState(finding.id, state, typeof note === 'string' ? note.slice(0, 2000) : null);
  res.json({ findings: getReviewFindings(task.id) });
});

// Send selected findings back to the implementer. Same effect as a reply (the
// implementer resumes with full context), but scoped to the findings the user
// actually wants addressed rather than the whole verdict.
router.post('/tasks/:taskId/findings/fix', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'awaiting_feedback') {
    res.status(400).json({ error: 'Task is not awaiting feedback' });
    return;
  }

  const { findingIds } = req.body;
  if (!Array.isArray(findingIds) || findingIds.length === 0) {
    res.status(400).json({ error: 'findingIds must be a non-empty array' });
    return;
  }

  const all = getReviewFindings(task.id);
  const selected = findingIds
    .filter((id: unknown) => typeof id === 'string')
    .map((id: string) => all.find(f => f.id === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);
  if (selected.length === 0) {
    res.status(404).json({ error: 'No matching findings' });
    return;
  }

  // Tag each finding with its ref and ask for a FINDING_REPORT, exactly as the
  // auto-review retry prompt does. This is not cosmetic: the findings below move
  // to 'fixing', and applyFindingReport reopens everything the implementer did
  // not report on. Without the refs and the format there is no report to parse,
  // so every finding sent from the inbox came back 'open' with no note — and on
  // an auto-review-off task no later reviewer pass exists to close them, leaving
  // them un-clearable however many times the user clicked Fix.
  const issueList = selected
    .map(f => `[${findingRef(f)}] ${f.body}${f.revision > 0 ? '  (RE-RAISED: your previous fix was judged inadequate)' : ''}`)
    .join('\n\n');
  const dismissed = getDismissedFindings(task.id);
  // Tell the implementer what NOT to touch as well, so it doesn't "helpfully"
  // fix a waived finding it can still see in the earlier conversation.
  const waiverNote = dismissed.length > 0
    ? `\n\nThe user has explicitly DISMISSED the following reviewer findings. Do not act on them, and do not undo or "improve" the code they refer to:\n${dismissed.map((f, i) => `${i + 1}. ${f.body}${f.note ? ` (user's reason: ${f.note})` : ''}`).join('\n')}`
    : '';
  const body = `${REVIEW_FIX_REPLY_PREFIX}. Each is tagged with a ref you must report against.\n\n${issueList}${waiverNote}\n\n${FINDING_REPORT_FORMAT}`;

  addMessage(task.id, 'user', body, undefined, req.user!.username, undefined, req.authSource, req.clientLabel);
  selected.forEach(f => setReviewFindingState(f.id, 'fixing'));
  resetReviewLoopCount(task.id);
  if (task.pending_complete) setPendingComplete(task.id, false);

  updateTaskStatus(task.id, 'queued');
  res.json({ task: getTask(task.id), findings: getReviewFindings(task.id) });
  runInBackground(`findings-fix ${task.id}`, () => processQueue(task.workspace_id));
});

// Touch a task: atomically record open time, return previous value
router.post('/tasks/:taskId/touch', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const db = getDb();
  const now = new Date().toISOString();
  const row = db.prepare('SELECT last_opened_at FROM tasks WHERE id = ?').get(task.id) as { last_opened_at: string | null } | undefined;
  const previousOpenedAt = row?.last_opened_at ?? null;
  db.prepare('UPDATE tasks SET last_opened_at = ? WHERE id = ?').run(now, task.id);
  res.json({ previousOpenedAt, openedAt: now });
});

// Mark task as completed
router.post('/tasks/:taskId/complete', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  // Only awaiting_feedback tasks can be completed. Running git ops on a
  // working task would corrupt Claude's tree; completing queued/failed/
  // cancelled tasks is semantically meaningless. (Re-checked under the lock
  // below — this is just a cheap early-out.)
  const isGitErrorFailedEarlyOut = task.status === 'failed' && task.failed_reason === 'git_error';
  if (task.status !== 'awaiting_feedback' && task.status !== 'completed' && !isGitErrorFailedEarlyOut) {
    res.status(400).json({ error: `Only tasks awaiting feedback can be completed (current status: ${task.status}).` });
    return;
  }

  // Run the git completion and the status transition atomically under the
  // per-workspace lock. The lock is the same one processQueue's deferred-
  // completion path takes, so a manual complete can no longer race the queued
  // completion (or a second complete click) and mark the task completed via a
  // silent early-return while another attempt is still merging the PR.
  const outcome = await withWorkspaceLock(task.workspace_id, async (): Promise<
    | { code: 200; completed?: boolean }
    | { code: 202 }
    | { code: 400 | 404 | 409; error: string }
  > => {
    // Re-read inside the lock — a concurrent completion may have advanced the task.
    const fresh = getTask(task.id);
    if (!fresh) return { code: 404, error: 'Task not found' };

    // Already completed by a concurrent/earlier request — treat as idempotent success.
    if (fresh.status === 'completed') return { code: 200 };

    // Allow retrying completion on a git-error failed task (user may have manually
    // resolved the issue and is clicking "Retry completion").
    const isGitErrorFailed = fresh.status === 'failed' && fresh.failed_reason === 'git_error';
    if (fresh.status !== 'awaiting_feedback' && !isGitErrorFailed) {
      return { code: 400, error: `Only tasks awaiting feedback can be completed (current status: ${fresh.status}).` };
    }

    // If another task is actively working on this workspace, defer completion
    // until the queue is idle. Even though each task has its own worktree, all
    // worktrees share ONE `.git` (object store + ref namespace), and completion
    // hits it hard: it fetches, pushes the task branch, merges the PR into the
    // default branch, and does a best-effort ff-pull of the shared main checkout
    // (task.project_dir). Running those ref/lock-heavy ops concurrently with a
    // live agent's git activity in another worktree risks transient "cannot lock
    // ref" failures — the exact spurious completion errors we want to avoid. So
    // we queue it and auto-finalize once the workspace is idle (see
    // processQueue's pending_complete flush).
    const working = getWorkingTask(fresh.workspace_id);
    if (working && working.id !== fresh.id) {
      if (!fresh.pending_complete) {
        setPendingComplete(fresh.id, true);
        addMessage(fresh.id, 'system', `Completion queued — will finalize after task "${working.title}" finishes on this workspace.`, undefined, undefined, undefined, req.authSource, req.clientLabel);
      }
      return { code: 202 };
    }

    // Handle git operations before marking complete — may block completion on
    // uncommitted changes (remote disabled) or on any git failure.
    const allowed = await handleTaskCompletionGit(fresh);
    if (allowed === 'git_error') {
      updateTaskStatus(fresh.id, 'failed', 'git_error');
      return { code: 409, error: 'Cannot complete: git operation blocked. See task messages for the exact reason.' };
    }
    if (!allowed) {
      // Intentional block (e.g. remote-disabled with uncommitted changes) —
      // keep the task in awaiting_feedback so the user can commit and retry.
      return { code: 409, error: 'Cannot complete: git operation blocked. See task messages for the exact reason.' };
    }

    setPendingComplete(fresh.id, false);
    updateTaskStatus(fresh.id, 'completed');
    return { code: 200, completed: true };
  });

  if (outcome.code === 200 && outcome.completed) {
    // Free the port range (shuts down the task's preview server). The worktree is
    // intentionally kept so the task can be reopened and continued; it is removed
    // only when the task is deleted. Done outside the lock — processQueue
    // re-acquires it, so neither may run while the lock is held. Backgrounded:
    // the task is already marked completed, so the response needn't wait for
    // these SSH round-trips.
    runInBackground(`complete-cleanup ${task.id}`, async () => {
      await cleanupPortRange(task).catch(() => {});
      await processQueue(task.workspace_id);
    });
  }

  if (outcome.code === 202) {
    res.status(202).json({ task: getTask(task.id), queued: true });
    return;
  }
  if (outcome.code === 409) {
    res.status(409).json({ error: outcome.error, task: getTask(task.id) });
    return;
  }
  if (outcome.code !== 200) {
    res.status(outcome.code).json({ error: outcome.error });
    return;
  }

  res.json({ task: getTask(task.id) });
});

// Reopen a completed task (back to awaiting_feedback for further iteration)
router.post('/tasks/:taskId/reopen', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'completed') {
    res.status(400).json({ error: 'Only completed tasks can be reopened' });
    return;
  }

  updateTaskStatus(task.id, 'awaiting_feedback');

  // Reopen is now a no-op for git — stash handling happens on next resume
  handleTaskReopenGit(task).catch(() => {});

  res.json({ task: getTask(task.id) });
});

// Manually trigger the red-team reviewer on a task awaiting feedback.
router.post('/tasks/:taskId/review', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'awaiting_feedback') {
    res.status(400).json({ error: `Only tasks awaiting feedback can be reviewed (current status: ${task.status}).` });
    return;
  }
  if (!task.worktree_path) {
    res.status(400).json({ error: 'This task has no worktree, so there is nothing to review.' });
    return;
  }
  // The reviewer is near-read-only and runs entirely inside this task's OWN
  // worktree (it reads the diff and inspects files there), so it can't corrupt
  // another task's tree. Launching it does, however, occupy a concurrency slot
  // (the task flips to `working`), so gate it on the same capacity rule as a
  // normal task launch rather than refusing whenever any other task is busy.
  // This matches auto-review, which already runs alongside other working tasks.
  if (getWorkingTaskCount(task.workspace_id) >= getMaxConcurrent(task.workspace_id)) {
    res.status(409).json({ error: 'Cannot review — this workspace is at its task concurrency limit.' });
    return;
  }
  try {
    const launched = await triggerManualReview(task);
    if (!launched) {
      res.status(400).json({ error: 'No changes to review — the task\'s working tree is clean.' });
      return;
    }
    res.json({ task: getTask(task.id) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to launch reviewer' });
  }
});

// Switch workspace to a task's branch
router.post('/tasks/:taskId/checkout', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  // Don't allow checkout while an agent is working on this workspace
  const working = getWorkingTask(task.workspace_id);
  if (working) {
    res.status(409).json({ error: 'Cannot switch branches while a task is running on this workspace' });
    return;
  }
  try {
    const message = await checkoutTaskBranch(task);
    addMessage(task.id, 'system', message, undefined, undefined, undefined, req.authSource, req.clientLabel);
    res.json({ ok: true, message });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to checkout branch' });
  }
});

// Retry a failed task — resumes the existing session with a continuation prompt
router.post('/tasks/:taskId/retry', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'failed' && task.status !== 'awaiting_feedback' && task.status !== 'cancelled') {
    res.status(400).json({ error: 'Only failed, cancelled, or awaiting_feedback tasks can be retried' });
    return;
  }

  const continuationPrompt = 'Continue where you left off.';
  addMessage(task.id, 'user', continuationPrompt, undefined, req.user!.username, undefined, req.authSource, req.clientLabel);

  // Retry → cancel pending completion; user is re-engaging.
  if (task.pending_complete) {
    setPendingComplete(task.id, false);
    addMessage(task.id, 'system', 'Pending completion cancelled — retry requested.', undefined, undefined, undefined, req.authSource, req.clientLabel);
  }

  // Queue and let processQueue handle concurrency — it will resume immediately
  // if a slot is available, or hold in queue until one opens up. Backgrounded:
  // the client polls the queued→working transition anyway.
  updateTaskStatus(task.id, 'queued');
  res.json({ task: getTask(task.id) });
  runInBackground(`retry-launch ${task.id}`, () => processQueue(task.workspace_id));
});

// Reset a task's Claude session — generates a new session_id so the next run
// starts fresh. Used to recover from context-window exhaustion. The caller
// supplies a continuation prompt that seeds the new session; prior CPM-visible
// messages remain in the UI but won't be in Claude's context.
router.post('/tasks/:taskId/reset-session', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status === 'working') {
    res.status(409).json({ error: 'Interrupt the task before resetting its session.' });
    return;
  }
  if (task.status !== 'failed' && task.status !== 'awaiting_feedback' && task.status !== 'cancelled') {
    res.status(400).json({ error: `Cannot reset session for a ${task.status} task.` });
    return;
  }

  const { continuationPrompt } = req.body;
  if (!continuationPrompt || typeof continuationPrompt !== 'string' || !continuationPrompt.trim()) {
    res.status(400).json({ error: 'continuationPrompt is required' });
    return;
  }

  resetTaskSession(task.id);
  addMessage(task.id, 'system', 'Session reset — starting a fresh Claude session. Prior messages remain visible here but are not in the agent\'s context.', undefined, undefined, undefined, req.authSource, req.clientLabel);
  addMessage(task.id, 'user', continuationPrompt, undefined, req.user!.username, undefined, req.authSource, req.clientLabel);

  if (task.pending_complete) {
    setPendingComplete(task.id, false);
  }

  // If another task is working on this workspace, queue this one; the queue
  // will pick it up later. Otherwise transition straight to queued and kick
  // the processor, which will route through launchTask with isResume=true
  // and feedback=continuationPrompt — and launchTask will see
  // session_initialized=0 and use --session-id, creating a fresh session.
  updateTaskStatus(task.id, 'queued');
  res.json({ task: getTask(task.id) });
  runInBackground(`reset-launch ${task.id}`, () => processQueue(task.workspace_id));
});

// Compact a task's Claude session — sends the `/compact` slash command via
// --resume so Claude Code summarizes prior turns and frees up context.
// Preserves the session id (unlike reset-session).
router.post('/tasks/:taskId/compact-session', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status === 'working') {
    res.status(409).json({ error: 'Interrupt the task before compacting its session.' });
    return;
  }
  if (task.status !== 'failed' && task.status !== 'awaiting_feedback' && task.status !== 'cancelled' && task.status !== 'queued') {
    res.status(400).json({ error: `Cannot compact session for a ${task.status} task.` });
    return;
  }
  if (!task.claude_session_id || task.session_initialized === 0) {
    res.status(400).json({ error: 'No Claude session to compact yet — the task must have run at least once.' });
    return;
  }
  const msgs = getMessages(task.id);
  if (!msgs.some(m => m.role === 'assistant')) {
    res.status(400).json({ error: 'No assistant turns to compact yet.' });
    return;
  }

  addMessage(task.id, 'system', 'Compacting session — Claude will summarize prior turns to free up context.', undefined, undefined, undefined, req.authSource, req.clientLabel);
  // Stored bare; launchTask attaches the summarization instructions on the way
  // out, so the chat shows a clean "/compact" rather than the instruction blob.
  addMessage(task.id, 'user', '/compact', undefined, req.user!.username, undefined, req.authSource, req.clientLabel);

  if (task.pending_complete) {
    setPendingComplete(task.id, false);
  }

  updateTaskStatus(task.id, 'queued');
  res.json({ task: getTask(task.id) });
  runInBackground(`compact-launch ${task.id}`, () => processQueue(task.workspace_id));
});

// Interrupt a working task (kills process but transitions to 'awaiting_feedback' so user can continue)
router.post('/tasks/:taskId/interrupt', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  if (task.status !== 'working') {
    res.status(400).json({ error: 'Only working tasks can be interrupted' });
    return;
  }

  interruptTask(task.id);

  res.json({ task: getTask(task.id) });
});

// Cancel a working task (transitions to 'cancelled' state instead of deleting)
router.post('/tasks/:taskId/cancel', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  if (task.status !== 'working' && task.status !== 'queued') {
    res.status(400).json({ error: 'Only working or queued tasks can be cancelled' });
    return;
  }

  if (task.status === 'working') {
    cancelTask(task.id);
  }

  updateTaskStatus(task.id, 'cancelled');
  res.json({ task: getTask(task.id) });

  // Free the port range (shuts down any preview server) and advance the queue in
  // the background — both are SSH round-trips the response needn't wait for. The
  // worktree is kept so the task can be retried/resumed later; worktrees are
  // removed only on deletion.
  runInBackground(`cancel-cleanup ${task.id}`, async () => {
    await cleanupPortRange(task).catch(() => {});
    await processQueue(task.workspace_id);
  });
});

// Delete a task (soft delete)
router.delete('/tasks/:taskId', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  if (task.status === 'working') {
    cancelTask(task.id);
  }

  // Stop any running advisor participants so they don't keep polling / writing
  // to a deleted task's conversation log.
  for (const p of getTaskParticipants(task.id)) {
    if (isTaskParticipantRunning(p.id)) {
      try { stopTaskParticipant(p.id); } catch { /* ignore */ }
    }
  }

  // Soft-delete first, respond immediately, clean up in the background. Doing
  // deleteTask before the cleanup also makes a crash mid-cleanup recoverable:
  // the row already has deleted_at set, which is exactly the shape the worktree
  // reconciler sweeps for.
  deleteTask(task.id);
  res.json({ ok: true, taskId: task.id });

  runInBackground(`delete-cleanup ${task.id}`, async () => {
    // Shut down preview servers first, then remove the worktree — a running
    // server holding the worktree open would otherwise block its removal.
    await cleanupPortRange(task).catch(() => {});
    if (task.worktree_path) {
      // Skip if the user hit Undo while cleanup was in flight — a restored
      // task keeps its worktree (the reconciler ignores non-deleted tasks).
      const fresh = getTask(task.id);
      if (fresh?.deleted_at) {
        await removeTaskWorktree(fresh).catch(() => {});
      }
    }
    await processQueue(task.workspace_id);
  });
});

// Restore a soft-deleted task
router.post('/tasks/:taskId/restore', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  restoreTask(task.id);
  res.json({ ok: true, task: getTask(task.id) });
});

// --- Task Participants (advisory agents) ---

// List participants for a task
router.get('/tasks/:taskId/participants', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const participants = getTaskParticipants(task.id).map(p => ({
    ...p,
    running: isTaskParticipantRunning(p.id),
    activity: getTaskParticipantActivity(p.id) || null,
  }));
  res.json({ participants });
});

// Invite a workspace as a participant
router.post('/tasks/:taskId/participants', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const { workspaceId, workspaceName } = req.body;
  if (!workspaceId || !workspaceName) {
    res.status(400).json({ error: 'workspaceId and workspaceName are required' });
    return;
  }

  // Can't add the task's own workspace
  if (workspaceId === task.workspace_id) {
    res.status(400).json({ error: 'Cannot add the task workspace as a participant' });
    return;
  }

  // Check not already a participant
  const existing = getTaskParticipants(task.id);
  if (existing.some(p => p.workspace_id === workspaceId)) {
    res.status(409).json({ error: 'Workspace is already a participant' });
    return;
  }

  const participant = addTaskParticipant(task.id, workspaceId, workspaceName);
  addMessage(task.id, 'system', `${workspaceName} joined as an advisor.`, undefined, undefined, undefined, req.authSource, req.clientLabel);

  res.status(201).json({ participant: { ...participant, running: false, activity: null } });
});

// Remove a participant
router.delete('/tasks/:taskId/participants/:participantId', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const participant = getTaskParticipant(req.params.participantId);
  if (!participant || participant.task_id !== task.id || participant.status !== 'active') {
    res.status(404).json({ error: 'Participant not found' });
    return;
  }

  if (isTaskParticipantRunning(participant.id)) {
    stopTaskParticipant(participant.id);
  }

  removeTaskParticipant(participant.id);
  addMessage(task.id, 'system', `${participant.workspace_name} left the task.`, undefined, undefined, undefined, req.authSource, req.clientLabel);

  res.json({ ok: true });
});

// Send a message to a task participant
router.post('/tasks/:taskId/participants/:participantId/message', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const participant = getTaskParticipant(req.params.participantId);
  if (!participant || participant.task_id !== task.id || participant.status !== 'active') {
    res.status(404).json({ error: 'Participant not found' });
    return;
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // Check no participant is currently running for this task
  const allParticipants = getTaskParticipants(task.id);
  if (allParticipants.some(p => isTaskParticipantRunning(p.id))) {
    res.status(409).json({ error: 'A participant agent is currently processing. Wait for it to finish.' });
    return;
  }

  // Store user message tagged with participant
  addMessage(task.id, 'user', message, undefined, req.user!.username, participant.id, req.authSource, req.clientLabel);

  // Check if this participant has spoken before (to determine resume)
  const msgs = getMessages(req.params.taskId);
  const isResume = msgs.some(m => m.role === 'assistant' && m.participant_id === participant.id);

  await launchTaskParticipant(task, participant, message, isResume);

  res.json({ ok: true });
});

// Nudge the host task agent to catch up on participant messages. Only acts when
// the task is awaiting feedback (idle) and there's unseen context.
router.post('/tasks/:taskId/catchup', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'awaiting_feedback') {
    res.status(409).json({ error: 'Task is not idle' });
    return;
  }
  await triggerTaskHostCatchUp(task.id);
  res.json({ ok: true });
});

// Nudge a participant agent to catch up on the task conversation.
router.post('/tasks/:taskId/participants/:participantId/catchup', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const participant = getTaskParticipant(req.params.participantId);
  if (!participant || participant.task_id !== task.id || participant.status !== 'active') {
    res.status(404).json({ error: 'Participant not found' });
    return;
  }
  if (isTaskParticipantRunning(participant.id)) {
    res.status(409).json({ error: 'Participant agent is currently processing' });
    return;
  }
  await triggerTaskParticipantCatchUp(task.id, participant.id);
  res.json({ ok: true });
});

// Approve a task request emitted by this task (delegation → new tracked task).
// Optional body `{ targetWorkspaceId }` overrides the stored target at approval
// time. Delegated tasks always branch from main (a normal new task).
router.post('/tasks/:taskId/task-requests/:requestId/approve', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const taskRequest = getTaskRequest(req.params.requestId);
  if (!taskRequest || taskRequest.task_id !== task.id) {
    res.status(404).json({ error: 'Task request not found' });
    return;
  }
  if (taskRequest.status !== 'pending') {
    res.status(400).json({ error: 'Task request already processed' });
    return;
  }

  // Determine target workspace: explicit body override > stored target > host
  let workspaceId = task.workspace_id;
  let workspaceName = task.workspace_name;
  const overrideId = typeof req.body?.targetWorkspaceId === 'string' ? req.body.targetWorkspaceId : null;
  const chosenId = overrideId ?? taskRequest.target_workspace_id;

  if (chosenId && chosenId !== task.workspace_id) {
    const cached = findUserWorkspaceById(req.user!.id, chosenId);
    if (cached) {
      workspaceId = cached.id;
      workspaceName = cached.name;
    } else {
      res.status(400).json({ error: 'Target workspace not found or you do not have access to it.' });
      return;
    }
  }

  const created = createTask({
    workspaceId,
    workspaceName,
    userId: req.user!.id,
    username: req.user!.username,
    prompt: taskRequest.prompt,
    source: req.authSource,
    clientLabel: req.clientLabel,
  });

  approveTaskRequest(taskRequest.id, created.id);
  const crossWorkspace = workspaceId !== task.workspace_id;
  const msg = crossWorkspace
    ? `Task created in ${workspaceName}: "${created.title}" (${created.id})`
    : `Task created: "${created.title}" (${created.id})`;
  addMessage(task.id, 'system', msg, undefined, undefined, undefined, req.authSource, req.clientLabel);

  res.json({ task: created });
  runInBackground(`approve-launch ${created.id}`, () => processQueue(workspaceId));
});

// Update the target workspace on a pending task request before approving.
router.patch('/tasks/:taskId/task-requests/:requestId/target', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const taskRequest = getTaskRequest(req.params.requestId);
  if (!taskRequest || taskRequest.task_id !== task.id) {
    res.status(404).json({ error: 'Task request not found' });
    return;
  }
  if (taskRequest.status !== 'pending') {
    res.status(400).json({ error: 'Task request already processed' });
    return;
  }

  const { targetWorkspaceId } = req.body ?? {};
  if (targetWorkspaceId === null || targetWorkspaceId === task.workspace_id) {
    setTaskRequestTarget(taskRequest.id, null);
    res.json({ ok: true, target: null });
    return;
  }
  const cached = findUserWorkspaceById(req.user!.id, targetWorkspaceId);
  if (!cached) {
    res.status(400).json({ error: 'Target workspace not found or you do not have access to it.' });
    return;
  }
  setTaskRequestTarget(taskRequest.id, { workspace_id: cached.id, workspace_name: cached.name });
  res.json({ ok: true, target: { id: cached.id, name: cached.name } });
});

// Dismiss a task request
router.post('/tasks/:taskId/task-requests/:requestId/dismiss', requireAuth, (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const taskRequest = getTaskRequest(req.params.requestId);
  if (!taskRequest || taskRequest.task_id !== task.id) {
    res.status(404).json({ error: 'Task request not found' });
    return;
  }
  if (taskRequest.status !== 'pending') {
    res.status(400).json({ error: 'Task request already processed' });
    return;
  }

  dismissTaskRequest(taskRequest.id);
  res.json({ ok: true });
});

export default router;
