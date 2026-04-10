import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getActiveDiscussion,
  getDiscussion,
  createDiscussion,
  closeDiscussion,
  updateDiscussionSessionId,
  updateDiscussionFullAccess,
  addDiscussionMessage,
  getDiscussionMessages,
  getTaskRequest,
  getPendingTaskRequests,
  approveTaskRequest,
  dismissTaskRequest,
  getDiscussionFullAccess,
  setDiscussionFullAccess,
} from '../services/discussions.js';
import { createTask } from '../services/tasks.js';
import { launchDiscussion, stopDiscussion, getDiscussionActivity, isDiscussionRunning, getRateLimitInfo } from '../services/claude.js';
import { getWorkspace, CoderAuthError } from '../services/coder.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { processQueue } from '../services/claude.js';

const router = Router();

// Get or create the active discussion for a workspace
router.post('/workspaces/:workspaceId/discussion', requireAuth, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId;

  // Check for existing active discussion
  let discussion = getActiveDiscussion(workspaceId);
  if (discussion) {
    const messages = getDiscussionMessages(discussion.id);
    const taskRequests = getPendingTaskRequests(discussion.id);
    const activity = getDiscussionActivity(discussion.id) || null;
    const running = isDiscussionRunning(discussion.id);
    const rateLimit = getRateLimitInfo(`disc:${discussion.id}`) || null;
    res.json({ discussion: { ...discussion, activity, running, rate_limit: rateLimit }, messages, taskRequests });
    return;
  }

  // Need workspace name — fetch from Coder API
  let token = req.session!.coder_access_token;
  let workspace;
  try {
    workspace = await getWorkspace(token, workspaceId);
  } catch (err) {
    if (err instanceof CoderAuthError && req.session!.coder_refresh_token) {
      const newToken = await refreshAccessToken(req.session!);
      if (newToken) {
        token = newToken;
        req.session!.coder_access_token = newToken;
        try {
          workspace = await getWorkspace(newToken, workspaceId);
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
      res.status(500).json({ error: 'Failed to fetch workspace' });
      return;
    }
  }

  const fullAccess = getDiscussionFullAccess(workspaceId);
  discussion = createDiscussion({
    workspaceId,
    workspaceName: workspace.name,
    userId: req.user!.id,
    fullAccess,
  });

  res.status(201).json({ discussion: { ...discussion, activity: null, running: false }, messages: [], taskRequests: [] });
});

// Get discussion details
router.get('/discussions/:discussionId', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  const messages = getDiscussionMessages(discussion.id);
  const taskRequests = getPendingTaskRequests(discussion.id);
  const activity = getDiscussionActivity(discussion.id) || null;
  const running = isDiscussionRunning(discussion.id);
  const rateLimit = getRateLimitInfo(`disc:${discussion.id}`) || null;
  res.json({ discussion: { ...discussion, activity, running, rate_limit: rateLimit }, messages, taskRequests });
});

// Update discussion session ID
router.patch('/discussions/:discussionId/session', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  if (discussion.status !== 'active') {
    res.status(400).json({ error: 'Discussion is closed' });
    return;
  }

  const { claudeSessionId } = req.body;
  if (!claudeSessionId || typeof claudeSessionId !== 'string') {
    res.status(400).json({ error: 'claudeSessionId is required' });
    return;
  }

  // Basic UUID format validation
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(claudeSessionId)) {
    res.status(400).json({ error: 'Invalid UUID format' });
    return;
  }

  updateDiscussionSessionId(discussion.id, claudeSessionId);
  res.json({ ok: true, claudeSessionId });
});

// Send a message to the discussion (launches/resumes Claude)
router.post('/discussions/:discussionId/message', requireAuth, async (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  if (discussion.status !== 'active') {
    res.status(400).json({ error: 'Discussion is closed' });
    return;
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // If Claude is currently running, we can't send another message yet
  if (isDiscussionRunning(discussion.id)) {
    res.status(409).json({ error: 'Discussion is currently processing. Wait for Claude to finish before sending another message.' });
    return;
  }

  // Store user message
  addDiscussionMessage(discussion.id, 'user', message, undefined, req.user!.username);

  // Check if this is the first message or a follow-up
  const messages = getDiscussionMessages(discussion.id);
  const isResume = messages.filter(m => m.role === 'assistant').length > 0;

  // Launch Claude (bypasses task queue entirely)
  await launchDiscussion(discussion, message, isResume, req.user!.username);

  res.json({ ok: true });
});

// Close a discussion
router.post('/discussions/:discussionId/close', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }

  // Stop any running process
  stopDiscussion(discussion.id);
  closeDiscussion(discussion.id);

  res.json({ ok: true });
});

// Approve a task request (creates a real task)
router.post('/discussions/:discussionId/task-requests/:requestId/approve', requireAuth, async (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }

  const taskRequest = getTaskRequest(req.params.requestId);
  if (!taskRequest || taskRequest.discussion_id !== discussion.id) {
    res.status(404).json({ error: 'Task request not found' });
    return;
  }
  if (taskRequest.status !== 'pending') {
    res.status(400).json({ error: 'Task request already processed' });
    return;
  }

  // Create the actual task
  const task = createTask({
    workspaceId: discussion.workspace_id,
    workspaceName: discussion.workspace_name,
    userId: req.user!.id,
    username: req.user!.username,
    prompt: taskRequest.prompt,
    branch: taskRequest.branch || undefined,
  });

  approveTaskRequest(taskRequest.id, task.id);
  addDiscussionMessage(discussion.id, 'system', `Task created: "${task.title}" (${task.id})`);

  // Kick the queue
  await processQueue(discussion.workspace_id);

  res.json({ task });
});

// Dismiss a task request
router.post('/discussions/:discussionId/task-requests/:requestId/dismiss', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }

  const taskRequest = getTaskRequest(req.params.requestId);
  if (!taskRequest || taskRequest.discussion_id !== discussion.id) {
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

// Get workspace discussion settings
router.get('/workspaces/:workspaceId/discussion-settings', requireAuth, (req: Request, res: Response) => {
  const fullAccess = getDiscussionFullAccess(req.params.workspaceId);
  res.json({ fullAccess });
});

// Update workspace discussion settings (persists across discussions)
router.patch('/workspaces/:workspaceId/discussion-settings', requireAuth, (req: Request, res: Response) => {
  const { fullAccess } = req.body;
  if (typeof fullAccess !== 'boolean') {
    res.status(400).json({ error: 'fullAccess must be a boolean' });
    return;
  }
  // Persist for future discussions
  setDiscussionFullAccess(req.params.workspaceId, fullAccess);
  // Also update the current active discussion if one exists
  const active = getActiveDiscussion(req.params.workspaceId);
  if (active) {
    updateDiscussionFullAccess(active.id, fullAccess);
  }
  res.json({ ok: true, fullAccess });
});

export default router;
