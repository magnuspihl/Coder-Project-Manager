import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  listTasks,
  getTask,
  getMessages,
  createTask,
  addMessage,
  updateTaskStatus,
  updateTaskTitle,
  deleteTask,
  getWorkingTask,
  getTaskParticipants,
} from '../services/tasks.js';
import {
  processQueue,
  resumeTask,
  cancelTask,
  interruptTask,
  isTaskParticipantRunning,
  stopTaskParticipant,
} from '../services/claude.js';
import {
  getActiveDiscussion,
  getDiscussion,
  createDiscussion,
  closeDiscussion,
  getDiscussionMessages,
  addDiscussionMessage,
  getDiscussionFullAccess,
  getParticipants,
} from '../services/discussions.js';
import {
  launchDiscussion,
  stopDiscussion,
  isDiscussionRunning,
  isParticipantRunning,
  isAnyAgentRunning,
} from '../services/claude.js';
import { listWorkspaces, getWorkspace, stopWorkspace, startWorkspace, CoderAuthError } from '../services/coder.js';

type AuthCtx = {
  token: string;
  userId: string;
  username: string;
  authSource: 'api' | 'ui';
  clientLabel: string | null;
};

function jsonResult(data: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function buildServer(ctx: AuthCtx): McpServer {
  const server = new McpServer(
    { name: 'coder-project-manager', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );

  // ── Read-only tools ─────────────────────────────────────────────────────

  server.registerTool(
    'list_workspaces',
    {
      description: 'List all Coder workspaces visible to the authenticated user, including running state and basic metadata.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const workspaces = await listWorkspaces(ctx.token);
        return jsonResult(workspaces.map(w => ({
          id: w.id,
          name: w.name,
          owner_name: w.owner_name,
          template_name: w.template_name,
          last_used_at: w.last_used_at,
          status: w.latest_build.status,
          running: w.latest_build.status === 'running',
        })));
      } catch (err) {
        return errorResult(err instanceof CoderAuthError ? 'Coder token rejected.' : `Failed to list workspaces: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_workspace',
    {
      description: 'Get details for a single Coder workspace by ID.',
      inputSchema: { workspace_id: z.string().describe('Coder workspace ID') },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      try {
        const ws = await getWorkspace(ctx.token, workspace_id);
        return jsonResult(ws);
      } catch (err) {
        return errorResult(`Failed to fetch workspace: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'List tasks for a workspace, ordered by queue position. Returns ID, title, status, prompt, and provenance.',
      inputSchema: { workspace_id: z.string().describe('Coder workspace ID') },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const tasks = listTasks(workspace_id).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        prompt: t.prompt,
        position: t.position,
        model: t.model,
        claude_session_id: t.claude_session_id,
        source: t.source,
        client_label: t.client_label,
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at,
        failed_reason: t.failed_reason,
        verification_url: t.verification_url,
      }));
      return jsonResult({ workspace_id, count: tasks.length, tasks });
    },
  );

  server.registerTool(
    'get_task',
    {
      description: 'Get a task with its full message history.',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
        message_limit: z.number().int().positive().max(500).optional().describe('Max number of messages to return (newest first if provided)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id, message_limit }) => {
      const task = getTask(task_id);
      if (!task) return errorResult('Task not found');
      const messages = getMessages(task_id, message_limit);
      const participants = getTaskParticipants(task_id);
      return jsonResult({ task, messages, participants });
    },
  );

  server.registerTool(
    'list_discussions',
    {
      description: 'Get the active discussion for a workspace (or null if none). Discussions are workspace-level chats separate from tasks.',
      inputSchema: { workspace_id: z.string().describe('Coder workspace ID') },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const discussion = getActiveDiscussion(workspace_id);
      return jsonResult({ workspace_id, discussion: discussion ?? null });
    },
  );

  server.registerTool(
    'get_discussion',
    {
      description: 'Get a discussion with its message history and participants.',
      inputSchema: {
        discussion_id: z.string().describe('Discussion ID'),
        message_limit: z.number().int().positive().max(500).optional().describe('Max messages to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ discussion_id, message_limit }) => {
      const discussion = getDiscussion(discussion_id);
      if (!discussion) return errorResult('Discussion not found');
      const messages = getDiscussionMessages(discussion_id, message_limit);
      const participants = getParticipants(discussion_id);
      return jsonResult({ discussion, messages, participants });
    },
  );

  // ── Creation / reply tools ──────────────────────────────────────────────

  server.registerTool(
    'create_task',
    {
      description: 'Create a new task on a workspace and enqueue it. The task starts running automatically if the workspace queue is idle.',
      inputSchema: {
        workspace_id: z.string().describe('Coder workspace ID'),
        prompt: z.string().min(1).describe('Initial prompt for the Claude agent'),
        model: z.string().optional().describe('Optional Claude model override (e.g. "sonnet", "opus")'),
        caveman: z.enum(['lite', 'full', 'ultra']).optional().describe('Optional caveman mode'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ workspace_id, prompt, model, caveman }) => {
      let workspace;
      try {
        workspace = await getWorkspace(ctx.token, workspace_id);
      } catch (err) {
        return errorResult(`Failed to fetch workspace: ${(err as Error).message}`);
      }
      try {
        const task = createTask({
          workspaceId: workspace_id,
          workspaceName: workspace.name,
          userId: ctx.userId,
          username: ctx.username,
          prompt,
          model,
          caveman,
          source: ctx.authSource,
          clientLabel: ctx.clientLabel,
        });
        await processQueue(workspace_id);
        return jsonResult({ task: getTask(task.id) });
      } catch (err) {
        return errorResult(`Failed to create task: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'reply_to_task',
    {
      description: 'Reply to a task that is awaiting feedback. Resumes the Claude session with the new message. If another task is working on the same workspace, this reply is queued.',
      inputSchema: {
        task_id: z.string(),
        message: z.string().min(1).describe('Reply message to send to Claude'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ task_id, message }) => {
      const task = getTask(task_id);
      if (!task) return errorResult('Task not found');
      if (task.status !== 'awaiting_feedback') {
        return errorResult(`Task is not awaiting feedback (current status: ${task.status})`);
      }
      addMessage(task.id, 'user', message, undefined, ctx.username, undefined, ctx.authSource, ctx.clientLabel);
      const working = getWorkingTask(task.workspace_id);
      if (working) {
        updateTaskStatus(task.id, 'queued');
        return jsonResult({ ok: true, queued: true, task: getTask(task.id) });
      }
      await resumeTask(task, message);
      return jsonResult({ ok: true, task: getTask(task.id) });
    },
  );

  server.registerTool(
    'rename_task',
    {
      description: 'Rename a task. Title must be 1-200 characters.',
      inputSchema: {
        task_id: z.string(),
        title: z.string().min(1).max(200),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ task_id, title }) => {
      const task = getTask(task_id);
      if (!task) return errorResult('Task not found');
      const trimmed = title.trim();
      if (!trimmed) return errorResult('Title cannot be empty');
      updateTaskTitle(task_id, trimmed);
      return jsonResult({ ok: true, task: getTask(task_id) });
    },
  );

  server.registerTool(
    'create_discussion',
    {
      description: 'Open (or return) the active discussion for a workspace. If one is already active, returns it instead of creating a new one.',
      inputSchema: {
        workspace_id: z.string(),
        model: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workspace_id, model }) => {
      const existing = getActiveDiscussion(workspace_id);
      if (existing) {
        return jsonResult({ discussion: existing, created: false });
      }
      let workspace;
      try {
        workspace = await getWorkspace(ctx.token, workspace_id);
      } catch (err) {
        return errorResult(`Failed to fetch workspace: ${(err as Error).message}`);
      }
      const fullAccess = getDiscussionFullAccess(workspace_id);
      const discussion = createDiscussion({
        workspaceId: workspace_id,
        workspaceName: workspace.name,
        userId: ctx.userId,
        fullAccess,
        model,
        source: ctx.authSource,
        clientLabel: ctx.clientLabel,
      });
      return jsonResult({ discussion, created: true });
    },
  );

  server.registerTool(
    'send_discussion_message',
    {
      description: 'Send a message to a workspace discussion. Launches or resumes the discussion agent.',
      inputSchema: {
        discussion_id: z.string(),
        message: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ discussion_id, message }) => {
      const discussion = getDiscussion(discussion_id);
      if (!discussion) return errorResult('Discussion not found');
      if (discussion.status !== 'active') return errorResult('Discussion is closed');
      const participantIds = getParticipants(discussion.id).map(p => p.id);
      if (isAnyAgentRunning(discussion.id, participantIds)) {
        return errorResult('An agent is currently processing. Wait for it to finish before sending another message.');
      }
      addDiscussionMessage(discussion.id, 'user', message, undefined, ctx.username, undefined, ctx.authSource, ctx.clientLabel);
      const messages = getDiscussionMessages(discussion.id);
      const isResume = messages.filter(m => m.role === 'assistant').length > 0;
      await launchDiscussion(discussion, message, isResume, ctx.username);
      return jsonResult({ ok: true });
    },
  );

  // ── Destructive / control tools ─────────────────────────────────────────

  server.registerTool(
    'interrupt_task',
    {
      description: 'Interrupt a working task. The Claude process is killed, but the task moves to awaiting_feedback so the user can continue.',
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ task_id }) => {
      const task = getTask(task_id);
      if (!task) return errorResult('Task not found');
      if (task.status !== 'working') return errorResult('Only working tasks can be interrupted');
      interruptTask(task.id);
      return jsonResult({ ok: true, task: getTask(task.id) });
    },
  );

  server.registerTool(
    'cancel_task',
    {
      description: 'Cancel a working or queued task. Working tasks are killed; the task transitions to "cancelled".',
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ task_id }) => {
      const task = getTask(task_id);
      if (!task) return errorResult('Task not found');
      if (task.status !== 'working' && task.status !== 'queued') {
        return errorResult('Only working or queued tasks can be cancelled');
      }
      if (task.status === 'working') cancelTask(task.workspace_id);
      updateTaskStatus(task.id, 'cancelled');
      await processQueue(task.workspace_id);
      return jsonResult({ ok: true, task: getTask(task.id) });
    },
  );

  server.registerTool(
    'delete_task',
    {
      description: 'Soft-delete a task. If it is working, it will be cancelled first. Any active participant agents are stopped.',
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ task_id }) => {
      const task = getTask(task_id);
      if (!task) return errorResult('Task not found');
      if (task.status === 'working') cancelTask(task.workspace_id);
      for (const p of getTaskParticipants(task.id)) {
        if (isTaskParticipantRunning(p.id)) {
          try { stopTaskParticipant(p.id); } catch { /* ignore */ }
        }
      }
      deleteTask(task.id);
      await processQueue(task.workspace_id);
      return jsonResult({ ok: true, task_id });
    },
  );

  server.registerTool(
    'interrupt_discussion',
    {
      description: 'Interrupt a running discussion or its currently running participant.',
      inputSchema: { discussion_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ discussion_id }) => {
      const discussion = getDiscussion(discussion_id);
      if (!discussion) return errorResult('Discussion not found');
      if (isDiscussionRunning(discussion.id)) {
        stopDiscussion(discussion.id);
        addDiscussionMessage(discussion.id, 'system', 'Discussion was interrupted via API.', undefined, undefined, undefined, ctx.authSource, ctx.clientLabel);
        return jsonResult({ ok: true, interrupted: 'host' });
      }
      const participants = getParticipants(discussion.id);
      const running = participants.find(p => isParticipantRunning(p.id));
      if (running) {
        // host stopper also stops participants in the same process group; reuse it
        stopDiscussion(discussion.id);
        addDiscussionMessage(discussion.id, 'system', `${running.workspace_name} was interrupted via API.`, undefined, undefined, undefined, ctx.authSource, ctx.clientLabel);
        return jsonResult({ ok: true, interrupted: running.workspace_name });
      }
      return errorResult('No agent is currently running');
    },
  );

  server.registerTool(
    'close_discussion',
    {
      description: 'Close a discussion. Stops any running agent and marks it as closed.',
      inputSchema: { discussion_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ discussion_id }) => {
      const discussion = getDiscussion(discussion_id);
      if (!discussion) return errorResult('Discussion not found');
      stopDiscussion(discussion.id);
      closeDiscussion(discussion.id);
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    'start_workspace',
    {
      description: 'Start a stopped Coder workspace.',
      inputSchema: { workspace_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workspace_id }) => {
      try {
        await startWorkspace(ctx.token, workspace_id);
        return jsonResult({ ok: true, workspace_id });
      } catch (err) {
        return errorResult(`Failed to start workspace: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'stop_workspace',
    {
      description: 'Stop a running Coder workspace.',
      inputSchema: { workspace_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ workspace_id }) => {
      try {
        await stopWorkspace(ctx.token, workspace_id);
        return jsonResult({ ok: true, workspace_id });
      } catch (err) {
        return errorResult(`Failed to stop workspace: ${(err as Error).message}`);
      }
    },
  );

  return server;
}

/** Express handler — one MCP server instance per request (stateless). */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const ctx: AuthCtx = {
    token: req.session!.coder_access_token,
    userId: req.user!.id,
    username: req.user!.username,
    authSource: (req.authSource ?? 'api') as 'api' | 'ui',
    clientLabel: req.clientLabel ?? null,
  };

  const server = buildServer(ctx);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] Request error:', (err as Error).message?.slice(0, 200));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

/** GET/DELETE on /mcp return 405 (per the MCP streamable HTTP spec for stateless mode). */
export function handleMcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}
