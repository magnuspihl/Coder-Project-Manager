import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
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
  setPendingComplete,
  resetTaskSession,
  addTaskParticipant,
  removeTaskParticipant,
  getTaskParticipants,
  getTaskParticipant,
  getTaskTurns,
  resetReviewLoopCount,
} from '../services/tasks.js';
import {
  getTaskRequest,
  getPendingTaskRequestsForTask,
  approveTaskRequest,
  dismissTaskRequest,
  setTaskRequestTarget,
} from '../services/discussions.js';
import { findUserWorkspaceById } from '../services/workspace-cache.js';
import { processQueue, cancelTask, interruptTask, getTaskActivity, getRateLimitInfo, getTaskStreamLog, getTaskStreamLogAfter, launchTaskParticipant, isTaskParticipantRunning, getTaskParticipantActivity, stopTaskParticipant, cleanupPortRange } from '../services/claude.js';
import { getWorkspace, CoderAuthError } from '../services/coder.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { handleTaskCompletionGit, handleTaskReopenGit, checkoutTaskBranch, switchActiveTask, getLastActiveTaskId, removeTaskWorktree } from '../services/git.js';
import { linkAttachmentsToTask, getAttachmentsByTask } from './uploads.js';
import { getDb } from '../db/index.js';

const router = Router();

// List tasks for a workspace
router.get('/workspaces/:workspaceId/tasks', requireAuth, (req: Request, res: Response) => {
  const costs = getTaskCostsByWorkspace(req.params.workspaceId);
  const tasks = listTasks(req.params.workspaceId).map(t => ({
    ...t,
    activity: t.status === 'working' ? getTaskActivity(t.id) || null : null,
    total_cost_usd: costs[t.id] || 0,
    rate_limit: getRateLimitInfo(t.id) || null,
  }));
  const activeTaskId = getLastActiveTaskId(req.params.workspaceId);
  res.json({ tasks, activeTaskId });
});

// Create a new task
router.post('/workspaces/:workspaceId/tasks', requireAuth, async (req: Request, res: Response) => {
  const { prompt, model, caveman, attachmentIds, autoReview } = req.body;
  if (!prompt) {
    res.status(400).json({ error: 'Prompt is required' });
    return;
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
      caveman: typeof caveman === 'string' && ['lite', 'full', 'ultra'].includes(caveman) ? caveman : undefined,
      source: req.authSource,
      clientLabel: req.clientLabel,
      autoReview: autoReview === false ? false : true,
    });

    if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
      linkAttachmentsToTask(attachmentIds.filter((id: unknown) => typeof id === 'string'), task.id);
    }

    await processQueue(req.params.workspaceId);
    res.status(201).json({ task: getTask(task.id) });
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
  const activeTaskId = getLastActiveTaskId(task.workspace_id);
  const turns = getTaskTurns(task.id);
  const taskRequests = getPendingTaskRequestsForTask(task.id);
  res.json({ task: { ...task, activity, total_cost_usd: totalCostUsd, rate_limit: rateLimit }, messages, totalMessages, participants, attachments, activeTaskId, turns, taskRequests });
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

  if (req.body.position !== undefined) {
    updateTaskPosition(task.id, req.body.position);
  }

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
    updateTaskTitle(task.id, trimmed);
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
  if (task.status !== 'awaiting_feedback') {
    res.status(400).json({ error: 'Task is not awaiting feedback' });
    return;
  }

  const { message, attachmentIds } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  addMessage(task.id, 'user', message, undefined, req.user!.username, undefined, req.authSource, req.clientLabel);

  // User reply resets the review loop so the next implementer turn gets a fresh review
  resetReviewLoopCount(task.id);

  // User replied → cancel any pending completion: they're asking to continue.
  if (task.pending_complete) {
    setPendingComplete(task.id, false);
    addMessage(task.id, 'system', 'Pending completion cancelled — reply received.', undefined, undefined, undefined, req.authSource, req.clientLabel);
  }

  if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
    linkAttachmentsToTask(attachmentIds.filter((a: unknown) => typeof a === 'string'), task.id);
  }

  // Queue and let processQueue handle concurrency — it will resume immediately
  // if a slot is available, or hold in queue until one opens up.
  updateTaskStatus(task.id, 'queued');
  await processQueue(task.workspace_id);
  res.json({ task: getTask(task.id) });
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
  // cancelled tasks is semantically meaningless.
  if (task.status !== 'awaiting_feedback') {
    res.status(400).json({ error: `Only tasks awaiting feedback can be completed (current status: ${task.status}).` });
    return;
  }

  // If another task is actively working on this workspace, defer completion
  // until the queue is idle. Otherwise concurrent git ops (stash/checkout/
  // commit) would corrupt the working agent's tree.
  const working = getWorkingTask(task.workspace_id);
  if (working && working.id !== task.id) {
    if (!task.pending_complete) {
      setPendingComplete(task.id, true);
      addMessage(task.id, 'system', `Completion queued — will finalize after task "${working.title}" finishes on this workspace.`, undefined, undefined, undefined, req.authSource, req.clientLabel);
    }
    res.status(202).json({ task: getTask(task.id), queued: true });
    return;
  }

  // Handle git operations before marking complete — may block completion on
  // uncommitted changes (remote disabled) or on any git failure.
  const allowed = await handleTaskCompletionGit(task);
  if (!allowed) {
    res.status(409).json({
      error: 'Cannot complete: git operation blocked. See task messages for the exact reason.',
      task: getTask(task.id),
    });
    return;
  }

  setPendingComplete(task.id, false);
  updateTaskStatus(task.id, 'completed');

  // Let the queue processor start the next task
  await processQueue(task.workspace_id);

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

// Make this task the active one on its workspace (stash swap)
router.post('/tasks/:taskId/set-active', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status === 'working' || task.status === 'completed') {
    res.status(400).json({ error: 'Cannot activate a working or completed task' });
    return;
  }
  const working = getWorkingTask(task.workspace_id);
  if (working) {
    res.status(409).json({ error: 'Cannot switch active task while a task is running on this workspace' });
    return;
  }
  try {
    const message = await switchActiveTask(task);
    addMessage(task.id, 'system', message, undefined, undefined, undefined, req.authSource, req.clientLabel);
    res.json({ ok: true, message, activeTaskId: task.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to set active task' });
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
  // if a slot is available, or hold in queue until one opens up.
  updateTaskStatus(task.id, 'queued');
  await processQueue(task.workspace_id);
  res.json({ task: getTask(task.id) });
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
  await processQueue(task.workspace_id);

  res.json({ task: getTask(task.id) });
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
  addMessage(task.id, 'user', '/compact', undefined, req.user!.username, undefined, req.authSource, req.clientLabel);

  if (task.pending_complete) {
    setPendingComplete(task.id, false);
  }

  updateTaskStatus(task.id, 'queued');
  await processQueue(task.workspace_id);

  res.json({ task: getTask(task.id) });
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

  if (task.worktree_path) {
    removeTaskWorktree(task).catch(() => {});
  }
  cleanupPortRange(task).catch(() => {});

  await processQueue(task.workspace_id);

  res.json({ task: getTask(task.id) });
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

  if (task.worktree_path) {
    removeTaskWorktree(task).catch(() => {});
  }
  cleanupPortRange(task).catch(() => {});

  deleteTask(task.id);

  await processQueue(task.workspace_id);

  res.json({ ok: true, taskId: task.id });
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

  await processQueue(workspaceId);

  res.json({ task: created });
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
