import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth.js';
import {
  listTasks,
  getTask,
  createTask,
  updateTaskStatus,
  updateTaskPosition,
  deleteTask,
  restoreTask,
  addMessage,
  getMessages,
  getMessageCount,
  getTaskCostUsd,
  getTaskCostsByWorkspace,
  getWorkingTask,
} from '../services/tasks.js';
import { processQueue, resumeTask, cancelTask, interruptTask, getTaskActivity, getRateLimitInfo, getTaskStreamLog, getTaskStreamLogAfter } from '../services/claude.js';
import { getWorkspace, CoderAuthError } from '../services/coder.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { getDb } from '../db/index.js';
import { handleTaskCompletionGit, handleTaskReopenGit } from '../services/git.js';

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
  res.json({ tasks });
});

// Create a new task
router.post('/workspaces/:workspaceId/tasks', requireAuth, async (req: Request, res: Response) => {
  const { prompt, branch } = req.body;
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
      branch: typeof branch === 'string' ? branch.trim() : undefined,
    });

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
  res.json({ task: { ...task, activity, total_cost_usd: totalCostUsd, rate_limit: rateLimit }, messages, totalMessages });
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

  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  addMessage(task.id, 'user', message, undefined, req.user!.username);

  // If another task is currently working on this workspace, queue the reply
  // instead of resuming immediately — only one Claude session at a time.
  const working = getWorkingTask(task.workspace_id);
  if (working) {
    updateTaskStatus(task.id, 'queued');
    res.json({ task: getTask(task.id) });
    return;
  }

  // No other task working — resume immediately
  await resumeTask(task, message);
  res.json({ task: getTask(task.id) });
});

// Mark task as completed
router.post('/tasks/:taskId/complete', requireAuth, async (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  updateTaskStatus(task.id, 'completed');

  // Completion signals acceptance — create PR and merge the feature branch.
  // Must finish before the next task starts to avoid concurrent git operations.
  await handleTaskCompletionGit(task);

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

  // Reopening starts a new feature branch for continued work
  handleTaskReopenGit(task).catch(() => {});

  res.json({ task: getTask(task.id) });
});

// Retry a failed task
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

  // Generate a new session ID and re-queue
  const newSessionId = uuid();
  getDb().prepare('UPDATE tasks SET claude_session_id = ? WHERE id = ?').run(newSessionId, task.id);
  updateTaskStatus(task.id, 'queued');

  // Let the queue processor decide whether to start it now
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
    cancelTask(task.workspace_id);
  }

  updateTaskStatus(task.id, 'cancelled');

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
    cancelTask(task.workspace_id);
  }

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

export default router;
