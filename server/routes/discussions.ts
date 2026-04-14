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
  getDiscussionMessageCount,
  getDiscussionMessagesAfterId,
  getTaskRequest,
  getPendingTaskRequests,
  approveTaskRequest,
  dismissTaskRequest,
  getDiscussionFullAccess,
  setDiscussionFullAccess,
  addParticipant,
  removeParticipant,
  getParticipants,
  getParticipant,
  buildCatchUpContext,
} from '../services/discussions.js';

const CATCHUP_NUDGE = 'The user has switched to you. Review the conversation context above. ' +
  'If you have something relevant to add — a response, a question, or useful context — please do. ' +
  'If the conversation doesn\'t concern you or you have nothing to add, just say so briefly (e.g. "Nothing to add from my side.").';
import { createTask } from '../services/tasks.js';
import {
  launchDiscussion, stopDiscussion, getDiscussionActivity, isDiscussionRunning, getRateLimitInfo,
  launchParticipantDiscussion, stopParticipant, isParticipantRunning, getParticipantActivity, isAnyAgentRunning,
} from '../services/claude.js';
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
    const messages = getDiscussionMessages(discussion.id, 50);
    const totalMessages = getDiscussionMessageCount(discussion.id);
    const taskRequests = getPendingTaskRequests(discussion.id);
    const activity = getDiscussionActivity(discussion.id) || null;
    const running = isDiscussionRunning(discussion.id);
    const rateLimit = getRateLimitInfo(`disc:${discussion.id}`) || null;
    const participants = getParticipants(discussion.id).map(p => ({
      ...p,
      running: isParticipantRunning(p.id),
      activity: getParticipantActivity(p.id) || null,
    }));
    res.json({ discussion: { ...discussion, activity, running, rate_limit: rateLimit }, messages, totalMessages, taskRequests, participants });
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

  res.status(201).json({ discussion: { ...discussion, activity: null, running: false }, messages: [], taskRequests: [], participants: [] });
});

// Get discussion details (supports incremental polling via ?after=<messageId>)
router.get('/discussions/:discussionId', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  const afterId = req.query.after as string | undefined;
  const messages = afterId
    ? getDiscussionMessagesAfterId(discussion.id, afterId)
    : getDiscussionMessages(discussion.id, 50);
  const totalMessages = getDiscussionMessageCount(discussion.id);
  const taskRequests = getPendingTaskRequests(discussion.id);
  const activity = getDiscussionActivity(discussion.id) || null;
  const running = isDiscussionRunning(discussion.id);
  const rateLimit = getRateLimitInfo(`disc:${discussion.id}`) || null;

  // Include participants with running/activity state
  const participants = getParticipants(discussion.id).map(p => ({
    ...p,
    running: isParticipantRunning(p.id),
    activity: getParticipantActivity(p.id) || null,
  }));

  res.json({ discussion: { ...discussion, activity, running, rate_limit: rateLimit }, messages, totalMessages, taskRequests, participants });
});

// Load older messages before a given message ID
router.get('/discussions/:discussionId/messages', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  const beforeId = req.query.before as string;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  if (!beforeId) {
    res.status(400).json({ error: 'before parameter required' });
    return;
  }
  const messages = getDiscussionMessages(discussion.id, limit, beforeId);
  res.json({ messages });
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

  // If any agent (host or participant) is currently running, we can't send another message
  const participantIds = getParticipants(discussion.id).map(p => p.id);
  if (isAnyAgentRunning(discussion.id, participantIds)) {
    res.status(409).json({ error: 'An agent is currently processing. Wait for it to finish before sending another message.' });
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

// Interrupt a running discussion (kills process but keeps discussion active)
router.post('/discussions/:discussionId/interrupt', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }

  // Stop host if running
  if (isDiscussionRunning(discussion.id)) {
    stopDiscussion(discussion.id);
    addDiscussionMessage(discussion.id, 'system', 'Discussion was interrupted by user.');
    res.json({ ok: true });
    return;
  }

  // Stop any running participant
  const participants = getParticipants(discussion.id);
  const runningParticipant = participants.find(p => isParticipantRunning(p.id));
  if (runningParticipant) {
    stopParticipant(runningParticipant.id);
    addDiscussionMessage(discussion.id, 'system', `${runningParticipant.workspace_name} was interrupted by user.`);
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'No agent is currently running' });
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
  if (active && active.full_access !== (fullAccess ? 1 : 0)) {
    updateDiscussionFullAccess(active.id, fullAccess);
    // Add a system message so it's visible in the chat
    const modeLabel = fullAccess ? 'Full Access' : 'Read-Only';
    addDiscussionMessage(active.id, 'system', `Access mode changed to ${modeLabel}. This takes effect on the next message.`);
  }
  res.json({ ok: true, fullAccess });
});

// ─── Participant endpoints ──────────────────────────────

// List active participants
router.get('/discussions/:discussionId/participants', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  const participants = getParticipants(discussion.id).map(p => ({
    ...p,
    running: isParticipantRunning(p.id),
    activity: getParticipantActivity(p.id) || null,
  }));
  res.json({ participants });
});

// Add a participant (invite a workspace)
router.post('/discussions/:discussionId/participants', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  if (discussion.status !== 'active') {
    res.status(400).json({ error: 'Discussion is closed' });
    return;
  }

  const { workspaceId, workspaceName } = req.body;
  if (!workspaceId || !workspaceName) {
    res.status(400).json({ error: 'workspaceId and workspaceName are required' });
    return;
  }

  // Check not already a participant
  const existing = getParticipants(discussion.id);
  if (existing.some(p => p.workspace_id === workspaceId)) {
    res.status(409).json({ error: 'Workspace is already a participant' });
    return;
  }

  // Can't add the host workspace as a participant
  if (workspaceId === discussion.workspace_id) {
    res.status(400).json({ error: 'Cannot add the host workspace as a participant' });
    return;
  }

  const participant = addParticipant(discussion.id, workspaceId, workspaceName);
  addDiscussionMessage(discussion.id, 'system', `${workspaceName} joined the discussion.`);

  res.status(201).json({ participant: { ...participant, running: false, activity: null } });
});

// Remove a participant
router.delete('/discussions/:discussionId/participants/:participantId', requireAuth, (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }

  const participant = getParticipant(req.params.participantId);
  if (!participant || participant.discussion_id !== discussion.id || participant.status !== 'active') {
    res.status(404).json({ error: 'Participant not found' });
    return;
  }

  // Stop if running
  if (isParticipantRunning(participant.id)) {
    stopParticipant(participant.id);
  }

  removeParticipant(participant.id);
  addDiscussionMessage(discussion.id, 'system', `${participant.workspace_name} left the discussion.`);

  res.json({ ok: true });
});

// Send a message to a specific participant
router.post('/discussions/:discussionId/participants/:participantId/message', requireAuth, async (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) {
    res.status(404).json({ error: 'Discussion not found' });
    return;
  }
  if (discussion.status !== 'active') {
    res.status(400).json({ error: 'Discussion is closed' });
    return;
  }

  const participant = getParticipant(req.params.participantId);
  if (!participant || participant.discussion_id !== discussion.id || participant.status !== 'active') {
    res.status(404).json({ error: 'Participant not found' });
    return;
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // Check no agent is currently running
  const allParticipantIds = getParticipants(discussion.id).map(p => p.id);
  if (isAnyAgentRunning(discussion.id, allParticipantIds)) {
    res.status(409).json({ error: 'An agent is currently processing. Wait for it to finish.' });
    return;
  }

  // Store user message tagged with participant
  addDiscussionMessage(discussion.id, 'user', message, undefined, req.user!.username, participant.id);

  // Check if this participant has spoken before (to determine resume)
  const messages = getDiscussionMessages(discussion.id);
  const isResume = messages.some(m => m.role === 'assistant' && m.participant_id === participant.id);

  // Launch on participant's workspace
  await launchParticipantDiscussion(discussion, participant, message, isResume, req.user!.username);

  res.json({ ok: true });
});

// Send catch-up context to the host agent (no user message, just context)
router.post('/discussions/:discussionId/catchup', requireAuth, async (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) { res.status(404).json({ error: 'Discussion not found' }); return; }
  if (discussion.status !== 'active') { res.status(400).json({ error: 'Discussion is closed' }); return; }

  const allParticipantIds = getParticipants(discussion.id).map(p => p.id);
  if (isAnyAgentRunning(discussion.id, allParticipantIds)) {
    res.status(409).json({ error: 'An agent is currently processing.' }); return;
  }

  const catchUp = buildCatchUpContext(discussion.id, '__host__');
  if (!catchUp) { res.json({ ok: true, skipped: true }); return; }

  const nudge = catchUp + '\n' + CATCHUP_NUDGE;

  const messages = getDiscussionMessages(discussion.id);
  const isResume = messages.some(m => m.role === 'assistant' && !m.participant_id);

  await launchDiscussion(discussion, nudge, isResume, req.user!.username, true);
  res.json({ ok: true, skipped: false });
});

// Send catch-up context to a participant agent (no user message, just context)
router.post('/discussions/:discussionId/participants/:participantId/catchup', requireAuth, async (req: Request, res: Response) => {
  const discussion = getDiscussion(req.params.discussionId);
  if (!discussion) { res.status(404).json({ error: 'Discussion not found' }); return; }
  if (discussion.status !== 'active') { res.status(400).json({ error: 'Discussion is closed' }); return; }

  const participant = getParticipant(req.params.participantId);
  if (!participant || participant.discussion_id !== discussion.id || participant.status !== 'active') {
    res.status(404).json({ error: 'Participant not found' }); return;
  }

  const allParticipantIds = getParticipants(discussion.id).map(p => p.id);
  if (isAnyAgentRunning(discussion.id, allParticipantIds)) {
    res.status(409).json({ error: 'An agent is currently processing.' }); return;
  }

  const catchUp = buildCatchUpContext(discussion.id, participant.id);
  if (!catchUp) { res.json({ ok: true, skipped: true }); return; }

  const nudge = catchUp + '\n' + CATCHUP_NUDGE;

  const messages = getDiscussionMessages(discussion.id);
  const isResume = messages.some(m => m.role === 'assistant' && m.participant_id === participant.id);

  await launchParticipantDiscussion(discussion, participant, nudge, isResume, req.user!.username, true);
  res.json({ ok: true, skipped: false });
});

export default router;
