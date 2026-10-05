import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  listTasks,
  getTask,
  getMessages,
  getMessageCount,
  createTask,
  addMessage,
  updateTaskStatus,
  updateTaskTitle,
  deleteTask,
  setPendingComplete,
  resetTaskWakeCount,
  getWorkingTask,
  getWorkingTaskCount,
  getMaxConcurrent,
  getTaskParticipants,
  getTaskTurns,
  getReviewFindings,
  type Message,
  type TaskTurn,
  type TaskParticipant,
  type Task,
} from '../services/tasks.js';
import {
  processQueue,
  cancelTask,
  interruptTask,
  isTaskParticipantRunning,
  stopTaskParticipant,
  cleanupPortRange,
  withWorkspaceLock,
  triggerManualReview, triggerManualAudit,
  getTaskBranchDiff,
  MAX_REVIEW_LOOPS,
} from '../services/claude.js';
import { sendFindingsToImplementer } from '../services/fix-send.js';
import { auditSummary, auditView, countImplementerTurns, getLatestAudit } from '../services/audits.js';
import { handleTaskCompletionGit, removeTaskWorktree } from '../services/git.js';
import { listWorkspaces, getWorkspace, stopWorkspace, startWorkspace, CoderAuthError } from '../services/coder.js';

type AuthCtx = {
  token: string;
  userId: string;
  username: string;
  authSource: 'api' | 'ui';
  clientLabel: string | null;
};

/**
 * Load a task only if it belongs to the authenticated MCP caller. The REST
 * routes enforce ownership via requireTaskAccess middleware; the task-scoped
 * MCP tools resolve tasks purely by ID, so without this an API-token holder
 * could read/mutate/delete any user's task by ID. Returns null for both
 * "missing" and "not yours" so callers surface an identical "Task not found".
 */
function getOwnedTask(taskId: string, ctx: AuthCtx): Task | null {
  const task = getTask(taskId);
  if (!task || task.user_id !== ctx.userId) return null;
  return task;
}

/** The send_findings_to_implementer tool: same semantics as the UI's "Send selected to implementer". Exported for tests. */
export function runSendFindings(
  ctx: AuthCtx,
  input: { task_id: string; review_finding_ids?: string[]; audit_finding_ids?: string[]; note?: string },
  launch?: (workspaceId: string) => void,
) {
  const task = getOwnedTask(input.task_id, ctx);
  if (!task) return errorResult('Task not found');
  const result = sendFindingsToImplementer({
    task,
    reviewIds: input.review_finding_ids,
    auditIds: input.audit_finding_ids,
    note: input.note,
    actor: { username: ctx.username, source: ctx.authSource, clientLabel: ctx.clientLabel },
  }, launch);
  if (!result.ok) return errorResult(result.error);
  return jsonResult({ ok: true, sent: result.sent, task: result.task });
}

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

// Fire-and-forget for remote work (SSH round-trips) whose outcome the tool
// result doesn't depend on — mirrors runInBackground in routes/tasks.ts.
// Failures are recovered by the worktree reconciler / port janitor, and launch
// errors inside processQueue mark the task failed with a message.
function runInBackground(label: string, fn: () => Promise<void>): void {
  fn().catch((err) =>
    console.error(`[mcp] background ${label} failed: ${(err as Error)?.message?.slice(0, 200)}`),
  );
}

/**
 * Resolve who actually authored a message. Both the implementer and the
 * read-only reviewer are persisted with role 'assistant', so callers can't tell
 * them apart from `role` alone — the distinction lives on the message's turn.
 * Returns a stable author label and surfaces the turn role explicitly.
 */
function attributeMessages(
  messages: Message[],
  turns: TaskTurn[],
  participants: TaskParticipant[],
): Array<Message & { author: string; turn_role: 'implementer' | 'reviewer' | null }> {
  const turnRole = new Map(turns.map(t => [t.id, t.role]));
  const participantName = new Map(participants.map(p => [p.id, p.workspace_name]));
  return messages.map(m => {
    const role = m.turn_id ? turnRole.get(m.turn_id) ?? null : null;
    let author: string;
    if (m.role === 'assistant') {
      if (m.participant_id) author = `participant:${participantName.get(m.participant_id) ?? m.participant_id}`;
      else if (role === 'reviewer') author = 'reviewer';
      else author = 'implementer';
    } else if (m.role === 'user') {
      author = 'user';
    } else {
      author = m.role; // system, etc.
    }
    return { ...m, author, turn_role: role };
  });
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
      description: 'List tasks for a workspace, ordered by queue position. Returns ID, title, status, prompt, provenance, timestamps, and review-loop progress.',
      inputSchema: { workspace_id: z.string().describe('Coder workspace ID') },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const tasks = listTasks(workspace_id, ctx.userId).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        prompt: t.prompt,
        position: t.position,
        model: t.model,
        claude_session_id: t.claude_session_id,
        source: t.source,
        client_label: t.client_label,
        // Auto-review loop progress. review_loop_count is how many failed
        // reviewer passes have routed back to the implementer so far;
        // max_review_loop_count is the cap after which the reviewer stops
        // looping and returns control to the user.
        review_loop_count: t.review_loop_count,
        max_review_loop_count: MAX_REVIEW_LOOPS,
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
      description: 'Get a task with its message history. When message_limit is set, returns the most recent N messages (in chronological order), not the oldest. Each reviewer turn has a review_outcome of "pass", "fail" or "partial" (a review that did not see all the changed files — not a pass). Each message includes an "author" field ("implementer", "reviewer", "user", "system", or "participant:<workspace>") and "turn_role", since the implementer and the read-only reviewer are both stored with role "assistant".',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
        message_limit: z.number().int().positive().max(500).optional().describe('If set, return only the most recent N messages (newest, in chronological order). Omit for the full history.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id, message_limit }) => {
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      // getMessages(limit) returns the OLDEST N (ORDER BY created_at ASC LIMIT).
      // The caller wants the most recent N, so offset to the tail of the list;
      // they come back in chronological order, which reads naturally.
      let messages: Message[];
      if (message_limit) {
        const total = getMessageCount(task_id);
        const offset = Math.max(0, total - message_limit);
        messages = getMessages(task_id, message_limit, offset);
      } else {
        messages = getMessages(task_id);
      }
      const participants = getTaskParticipants(task_id);
      const turns = getTaskTurns(task_id);
      return jsonResult({
        task,
        messages: attributeMessages(messages, turns, participants),
        turns,
        participants,
        // Counts only — the full report is get_audit, to keep this output small.
        audit: auditSummary(getLatestAudit(task_id), countImplementerTurns(task_id)),
        // The reviewer's findings still in play, with the ids send_findings_to_implementer takes.
        findings: getReviewFindings(task_id)
          .filter(f => f.state === 'open' || f.state === 'fixing')
          .map(f => ({ id: f.id, state: f.state, severity: f.severity, proof_status: f.proof_status, body: f.body.slice(0, 400) })),
      });
    },
  );

  server.registerTool(
    'get_audit',
    {
      description: 'Get the auditor\'s report for a task: an independent account of what was built, written from the code and the task prompt WITHOUT the implementer\'s summary, then compared with that summary. Fields: status (running, done, failed, cancelled, skipped — with reason), stale (true when the code changed after the audit; stale_label says so), and report: summary; structure (new and modified files); reuseFindings (kind reused, possible_duplicate or new, each with file:line citations); deviations from the repo\'s conventions; hardToReverse (schema, route, MCP tool, dependency and env-var changes, computed from the diff by the harness, not the model); discrepancies between the implementer\'s summary and the code (null if that comparison did not happen — see discrepanciesNote); unassessedExports (new exports the auditor gave no reuse entry for). Every citation carries a check: ok=false means it could not be verified — do not trust it. A possible_duplicate with verified=false has a citation that does not resolve at the merge-base. Report.ownership maps each finding id to who owns the code: owner "task" (introduced or changed by this task — send it to the implementer with send_findings_to_implementer) or "pre_existing" (unchanged code — a separate task); an unverified citation counts as the task\'s own, and basis says why. report.resolvedSinceLastAudit lists earlier findings that no longer appear. Never blocks the task; it reports to the human.',
      inputSchema: { task_id: z.string().describe('Task ID') },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      const row = getLatestAudit(task_id);
      if (!row) return jsonResult({ task_id, audit: null, note: 'No audit has run for this task. Use the audit tool to run one.' });
      return jsonResult({ task_id, audit: auditView(row, countImplementerTurns(task_id)) });
    },
  );

  server.registerTool(
    'get_task_diff',
    {
      description: 'Get the code changes a task has made: a unified diff of the task\'s branch and working tree against the repository\'s default branch (main/master), plus a --stat summary and any untracked files. Requires the workspace to be running. Large diffs are truncated (see the truncated flag).',
      inputSchema: { task_id: z.string().describe('Task ID') },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      try {
        const result = await getTaskBranchDiff(task);
        return jsonResult({ task_id, ...result });
      } catch (err) {
        return errorResult(`Failed to get task diff: ${(err as Error).message}`);
      }
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
        // Return as soon as the task row exists — launching involves SSH
        // round-trips the caller observes via get_task polling anyway.
        runInBackground(`launch ${task.id}`, () => processQueue(workspace_id));
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
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      if (task.status !== 'awaiting_feedback') {
        return errorResult(`Task is not awaiting feedback (current status: ${task.status})`);
      }
      addMessage(task.id, 'user', message, { username: ctx.username, source: ctx.authSource, clientLabel: ctx.clientLabel });
      // Mirrors the REST reply route: a reply refills the auto-wake budget, and
      // the armed wake itself is cleared when launchTask starts the turn.
      resetTaskWakeCount(task.id);
      if (task.pending_complete) {
        setPendingComplete(task.id, false);
        addMessage(task.id, 'system', 'Pending completion cancelled — reply received.', { source: ctx.authSource, clientLabel: ctx.clientLabel });
      }
      // Queue and let processQueue resume the session — same path as the REST
      // reply route. Queueing + lock-serialized launch (instead of calling
      // resumeTask directly) both avoids a double-launch race between rapid
      // replies and lets the tool return without waiting for SSH round-trips.
      updateTaskStatus(task.id, 'queued');
      runInBackground(`reply-launch ${task.id}`, () => processQueue(task.workspace_id));
      return jsonResult({ ok: true, task: getTask(task.id) });
    },
  );

  server.registerTool(
    'complete_task',
    {
      description: 'Mark a task awaiting feedback as completed. Runs the task\'s git completion (commit/merge) before finalizing. If another task is working on the same workspace, completion is deferred until the queue is idle and the task is flagged pending-complete. Completing an already-completed task is a no-op.',
      inputSchema: { task_id: z.string().describe('Task ID') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ task_id }) => {
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');

      // Cheap early-out; re-checked under the lock below.
      const isGitErrorFailedEarlyOut = task.status === 'failed' && task.failed_reason === 'git_error';
      if (task.status !== 'awaiting_feedback' && task.status !== 'completed' && !isGitErrorFailedEarlyOut) {
        return errorResult(`Only tasks awaiting feedback can be completed (current status: ${task.status}).`);
      }

      // Run git completion and the status transition atomically under the
      // per-workspace lock so a manual complete cannot race the queued
      // deferred-completion path (or a second complete) — mirrors the REST
      // POST /tasks/:id/complete handler.
      const outcome = await withWorkspaceLock(task.workspace_id, async (): Promise<
        | { code: 200; completed?: boolean }
        | { code: 202 }
        | { code: 400 | 404 | 409; error: string }
      > => {
        const fresh = getTask(task.id);
        if (!fresh) return { code: 404, error: 'Task not found' };
        if (fresh.status === 'completed') return { code: 200 };
        const isGitErrorFailed = fresh.status === 'failed' && fresh.failed_reason === 'git_error';
        if (fresh.status !== 'awaiting_feedback' && !isGitErrorFailed) {
          return { code: 400, error: `Only tasks awaiting feedback can be completed (current status: ${fresh.status}).` };
        }

        // Defer if another task is working this workspace. Worktrees are isolated
        // per task, but all share one `.git`, so completion's fetch/push/ref
        // updates can hit transient lock contention with a live agent's git
        // activity. Queue it and auto-finalize once idle (see routes/tasks.ts for
        // the full rationale).
        const working = getWorkingTask(fresh.workspace_id);
        if (working && working.id !== fresh.id) {
          if (!fresh.pending_complete) {
            setPendingComplete(fresh.id, true);
            addMessage(fresh.id, 'system', `Completion queued — will finalize after task "${working.title}" finishes on this workspace.`, { source: ctx.authSource, clientLabel: ctx.clientLabel });
          }
          return { code: 202 };
        }

        const allowed = await handleTaskCompletionGit(fresh);
        if (allowed === 'git_error') {
          updateTaskStatus(fresh.id, 'failed', 'git_error');
          return { code: 409, error: 'Cannot complete: git operation blocked. See task messages for the exact reason.' };
        }
        if (!allowed) {
          // Intentional block (e.g. remote-disabled with uncommitted changes) — keep awaiting_feedback.
          return { code: 409, error: 'Cannot complete: git operation blocked. See task messages for the exact reason.' };
        }

        setPendingComplete(fresh.id, false);
        updateTaskStatus(fresh.id, 'completed');
        return { code: 200, completed: true };
      });

      if (outcome.code === 200 && outcome.completed) {
        // Free the port range; keep the worktree (removed only on delete).
        // Outside the lock — processQueue re-acquires it. Backgrounded: the
        // task is already marked completed.
        runInBackground(`complete-cleanup ${task.id}`, async () => {
          await cleanupPortRange(task).catch(() => {});
          await processQueue(task.workspace_id);
        });
      }

      if (outcome.code === 202) {
        return jsonResult({ ok: true, queued: true, task: getTask(task.id) });
      }
      if (outcome.code !== 200) {
        return errorResult(outcome.error);
      }
      return jsonResult({ ok: true, task: getTask(task.id) });
    },
  );

  server.registerTool(
    'review',
    {
      description: 'Trigger the red-team reviewer on a task awaiting feedback. The reviewer inspects the task\'s diff and emits a verdict: on "pass" the task returns to awaiting_feedback; on "partial" (nothing wrong found, but the reviewer never saw some changed files, listed in the review_proofs coverage of that turn) the task returns to awaiting_feedback and is NOT reviewed — do not report it as passed; on "fail" the issues are routed back to the implementer to fix (up to max_review_loop_count passes). The call returns as soon as the review is accepted (the task is then "working" with the reviewer active); the review-time verification and reviewer launch continue in the background, and a failure there appears as a system message on the task. Fails if the worktree is clean (nothing to review) or the workspace is already at its task concurrency limit.',
      inputSchema: { task_id: z.string().describe('Task ID') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ task_id }) => {
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      if (task.status !== 'awaiting_feedback') {
        return errorResult(`Only tasks awaiting feedback can be reviewed (current status: ${task.status}).`);
      }
      if (!task.worktree_path) {
        return errorResult('This task has no worktree, so there is nothing to review.');
      }
      // The reviewer is near-read-only and runs inside this task's own worktree,
      // so it can't corrupt another task's tree. It does occupy a concurrency
      // slot, so gate on capacity (matching a normal launch and auto-review)
      // rather than refusing whenever any other task is busy.
      if (getWorkingTaskCount(task.workspace_id) >= getMaxConcurrent(task.workspace_id)) {
        return errorResult('Cannot review — this workspace is at its task concurrency limit.');
      }
      try {
        const launched = await triggerManualReview(task);
        if (!launched) {
          return errorResult('No changes to review — the task\'s working tree is clean.');
        }
        return jsonResult({ ok: true, task: getTask(task.id) });
      } catch (err) {
        return errorResult(`Failed to launch reviewer: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'audit',
    {
      description: 'Run the auditor on a task now: a fresh read-only session that reads the task prompt, the branch diff against the default branch and the repo\'s architecture guidance (never the implementer\'s summary), reports what was built and where it duplicates existing code or departs from the repo\'s conventions, then compares its account with the implementer\'s summary. It never changes the task\'s status or sends work back. Returns as soon as the audit has started (status running); read the result with get_audit. Fails if the task is working, has no worktree, or already has an audit running.',
      inputSchema: { task_id: z.string().describe('Task ID') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ task_id }) => {
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      if (task.status === 'working') {
        return errorResult('The task is working — audit it once the turn has finished, so the audit is of finished code.');
      }
      const result = triggerManualAudit(task);
      if (!result.started) return errorResult(result.reason ?? 'Could not start the audit');
      return jsonResult({ ok: true, audit: auditView(getLatestAudit(task.id)!, countImplementerTurns(task.id)) });
    },
  );

  server.registerTool(
    'send_findings_to_implementer',
    {
      description: 'Send selected findings back to THIS task\'s implementer as ONE combined message and ONE implementer turn — the same as the UI\'s "Send selected to implementer". Use it for findings about code this task introduced (get_audit ownership.owner = "task"); pre-existing code belongs in a separate task. Select reviewer findings by id (get_task findings) and/or audit findings by id (get_audit, e.g. "r1", "d2"). Reviewer findings with a proof test are defects to make pass; audit findings are judgement calls the implementer may decline with a reason, steered by `note` (e.g. "use the existing constant; ignore the list one"). The task must be awaiting feedback. After the turn the normal loop applies: verification, review, then re-audit (the old audit becomes stale, and the new one lists what is resolved).',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
        review_finding_ids: z.array(z.string()).optional().describe('Reviewer finding ids'),
        audit_finding_ids: z.array(z.string()).optional().describe('Audit finding ids from the latest audit report'),
        note: z.string().max(4000).optional().describe('Free-text steer for the implementer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => runSendFindings(ctx, input),
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
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      const trimmed = title.trim();
      if (!trimmed) return errorResult('Title cannot be empty');
      updateTaskTitle(task_id, trimmed);
      return jsonResult({ ok: true, task: getTask(task_id) });
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
      const task = getOwnedTask(task_id, ctx);
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
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      if (task.status !== 'working' && task.status !== 'queued') {
        return errorResult('Only working or queued tasks can be cancelled');
      }
      if (task.status === 'working') cancelTask(task.id);
      updateTaskStatus(task.id, 'cancelled');
      // Free the port range (shuts down any preview server) and advance the
      // queue in the background — mirrors the REST cancel route. The worktree
      // is kept so the task can be retried; worktrees are removed on deletion.
      runInBackground(`cancel-cleanup ${task.id}`, async () => {
        await cleanupPortRange(task).catch(() => {});
        await processQueue(task.workspace_id);
      });
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
      const task = getOwnedTask(task_id, ctx);
      if (!task) return errorResult('Task not found');
      if (task.status === 'working') cancelTask(task.id);
      for (const p of getTaskParticipants(task.id)) {
        if (isTaskParticipantRunning(p.id)) {
          try { stopTaskParticipant(p.id); } catch { /* ignore */ }
        }
      }
      // Soft-delete first, clean up in the background — mirrors the REST delete
      // route. Previously this path never freed ports or removed the worktree
      // at all, relying entirely on the reconciler.
      deleteTask(task.id);
      runInBackground(`delete-cleanup ${task.id}`, async () => {
        // Shut down preview servers first, then remove the worktree — a running
        // server holding the worktree open would otherwise block its removal.
        await cleanupPortRange(task).catch(() => {});
        if (task.worktree_path) {
          // Skip if the task was restored while cleanup was in flight — a
          // restored task keeps its worktree.
          const fresh = getTask(task.id);
          if (fresh?.deleted_at) {
            await removeTaskWorktree(fresh).catch(() => {});
          }
        }
        await processQueue(task.workspace_id);
      });
      return jsonResult({ ok: true, task_id });
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
