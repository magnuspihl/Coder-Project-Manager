import { getDb } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { execFile } from 'child_process';

export interface Task {
  id: string;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  title: string;
  prompt: string;
  status: string;
  position: number;
  project_dir: string | null;
  claude_session_id: string | null;
  failed_reason: string | null;
  verification_url: string | null;
  ssh_pid: number | null;
  git_branch: string | null;
  github_repo_url: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Message {
  id: string;
  task_id: string;
  role: string;
  content: string;
  cost: number | null;
  created_at: string;
}

export interface TaskCounts {
  working: number;
  queued: number;
  awaiting_feedback: number;
  failed: number;
  completed: number;
  cancelled: number;
}

/**
 * Use Claude (via the claude CLI) to generate a short title for a task.
 * Fires asynchronously and updates the task row in the DB when done.
 */
function generateTitleAsync(taskId: string, prompt: string): void {
  // Truncate prompt to first 500 chars to keep the request small
  const truncated = prompt.length > 500 ? prompt.slice(0, 500) + '...' : prompt;
  const instruction = `Summarize this task in under 8 words as a short title. Output ONLY the title, nothing else:\n\n${truncated}`;

  execFile('claude', ['-p', instruction, '--model', 'haiku'], {
    timeout: 15000,
  }, (err, stdout) => {
    const title = (!err && stdout.trim()) ? stdout.trim() : null;
    if (title) {
      try {
        getDb().prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, taskId);
      } catch {
        // DB write failed — not critical, keep the fallback title
      }
    }
  });
}

/** Quick heuristic fallback title (used immediately before LLM responds). */
function generateTitleFallback(prompt: string): string {
  let text = prompt.split('\n')[0].trim();
  if (!text) return 'Untitled task';
  // Strip conversational prefixes
  let changed = true;
  while (changed) {
    const before = text;
    text = text.replace(/^(please\s+|can you\s+|could you\s+|would you\s+|i('d| would| want| need) (like )?(you )?to\s+|go ahead and\s+|hey[,!]?\s+|hi[,!]?\s+|i want\s+|i need\s+|just\s+)/i, '');
    changed = text !== before;
  }
  const words = text.split(/\s+/).slice(0, 8);
  text = words.join(' ');
  text = text.replace(/\s+(the|a|an|to|in|on|at|for|of|with|from|by|and|or)$/i, '');
  return (text.charAt(0).toUpperCase() + text.slice(1)) || 'Untitled task';
}

export function getTaskCountsByWorkspace(): Record<string, TaskCounts> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT workspace_id, status, COUNT(*) as count FROM tasks
     WHERE status IN ('working', 'queued', 'awaiting_feedback', 'failed', 'completed', 'cancelled')
       AND deleted_at IS NULL
     GROUP BY workspace_id, status`
  ).all() as Array<{ workspace_id: string; status: string; count: number }>;

  const result: Record<string, TaskCounts> = {};
  for (const row of rows) {
    if (!result[row.workspace_id]) {
      result[row.workspace_id] = { working: 0, queued: 0, awaiting_feedback: 0, failed: 0, completed: 0, cancelled: 0 };
    }
    result[row.workspace_id][row.status as keyof TaskCounts] = row.count;
  }
  return result;
}

export interface WorkspaceTokenTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

// Cache for token totals — recomputed at most once per 30 seconds
let tokenTotalsCache: { data: Record<string, WorkspaceTokenTotals>; timestamp: number } | null = null;
const TOKEN_TOTALS_CACHE_MS = 30_000;

export function getTokenTotalsByWorkspace(): Record<string, WorkspaceTokenTotals> {
  const now = Date.now();
  if (tokenTotalsCache && (now - tokenTotalsCache.timestamp) < TOKEN_TOTALS_CACHE_MS) {
    return tokenTotalsCache.data;
  }

  const db = getDb();
  // Only scan non-deleted tasks; use pre-joined cost subquery filtered to those tasks
  const rows = db.prepare(
    `SELECT
       t.workspace_id,
       SUM(t.total_input_tokens) as total_input_tokens,
       SUM(t.total_output_tokens) as total_output_tokens,
       COALESCE(SUM(mc.max_cost), 0) as total_cost_usd
     FROM tasks t
     LEFT JOIN (
       SELECT m.task_id, MAX(m.cost) as max_cost
       FROM messages m
       WHERE m.cost IS NOT NULL
       GROUP BY m.task_id
     ) mc ON mc.task_id = t.id
     GROUP BY t.workspace_id`
  ).all() as Array<{ workspace_id: string; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }>;

  const result: Record<string, WorkspaceTokenTotals> = {};
  for (const row of rows) {
    result[row.workspace_id] = {
      total_input_tokens: row.total_input_tokens || 0,
      total_output_tokens: row.total_output_tokens || 0,
      total_cost_usd: row.total_cost_usd || 0,
    };
  }
  tokenTotalsCache = { data: result, timestamp: now };
  return result;
}

/** Invalidate the token totals cache (call after cost-changing operations). */
export function invalidateTokenTotalsCache(): void {
  tokenTotalsCache = null;
}

export function getTaskCostUsd(taskId: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(cost) as max_cost FROM messages WHERE task_id = ? AND cost IS NOT NULL'
  ).get(taskId) as { max_cost: number | null } | undefined;
  return row?.max_cost || 0;
}

export function getTaskCostsByWorkspace(workspaceId: string): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT m.task_id, MAX(m.cost) as max_cost
     FROM messages m JOIN tasks t ON m.task_id = t.id
     WHERE t.workspace_id = ? AND t.deleted_at IS NULL AND m.cost IS NOT NULL
     GROUP BY m.task_id`
  ).all(workspaceId) as Array<{ task_id: string; max_cost: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.task_id] = row.max_cost;
  }
  return result;
}

export function listTasks(workspaceId: string): Task[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY position ASC')
    .all(workspaceId) as Task[];
}

export function getTask(taskId: string): Task | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

export function createTask(params: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  username: string;
  prompt: string;
  projectDir?: string;
}): Task {
  const db = getDb();
  const id = uuid();
  const claudeSessionId = uuid();

  // Get next position for this workspace
  const maxPos = db
    .prepare('SELECT COALESCE(MAX(position), 0) as max_pos FROM tasks WHERE workspace_id = ?')
    .get(params.workspaceId) as { max_pos: number };
  const position = maxPos.max_pos + 10;

  // Immediate heuristic title; LLM will refine it async
  const title = generateTitleFallback(params.prompt);

  db.prepare(
    `INSERT INTO tasks (id, workspace_id, workspace_name, user_id, title, prompt, status, position, project_dir, claude_session_id)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
  ).run(id, params.workspaceId, params.workspaceName, params.userId, title, params.prompt, position, params.projectDir || null, claudeSessionId);

  // Store the initial prompt as a user message
  addMessage(id, 'user', params.prompt, undefined, params.username);

  // Fire off async LLM title generation (updates DB when ready)
  generateTitleAsync(id, params.prompt);

  return getTask(id)!;
}

export function updateTaskStatus(taskId: string, status: string, failedReason?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (status === 'completed') {
    db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?').run(
      status, now, now, taskId
    );
    // Clean up stream_log to prevent unbounded table growth
    db.prepare('DELETE FROM stream_log WHERE task_id = ?').run(taskId);
  } else if (status === 'failed' && failedReason) {
    db.prepare('UPDATE tasks SET status = ?, failed_reason = ?, updated_at = ? WHERE id = ?').run(
      status, failedReason, now, taskId
    );
  } else {
    db.prepare('UPDATE tasks SET status = ?, failed_reason = NULL, updated_at = ? WHERE id = ?').run(status, now, taskId);
  }
}

export function updateTaskPosition(taskId: string, newPosition: number): void {
  const db = getDb();
  db.prepare('UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?').run(
    newPosition, new Date().toISOString(), taskId
  );
}

export function deleteTask(taskId: string): void {
  const db = getDb();
  db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), taskId);
}

export function restoreTask(taskId: string): void {
  const db = getDb();
  db.prepare('UPDATE tasks SET deleted_at = NULL WHERE id = ?').run(taskId);
}

export function getNextQueuedTask(workspaceId: string): Task | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_id = ? AND status = 'queued' AND deleted_at IS NULL ORDER BY position ASC LIMIT 1")
    .get(workspaceId) as Task | undefined;
}

export function getWorkingTask(workspaceId: string): Task | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_id = ? AND status = 'working' AND deleted_at IS NULL LIMIT 1")
    .get(workspaceId) as Task | undefined;
}

/**
 * Extract a Coder proxy URL from text content.
 * Matches URLs like https://5173--main--workspace--user.coder.example.com/...
 */
function extractVerificationUrl(content: string): string | null {
  // Match Coder subdomain proxy URLs: https://PORT--agent--workspace--user.domain
  const match = content.match(/https?:\/\/\d+--[a-zA-Z0-9._-]+--[a-zA-Z0-9._-]+--[a-zA-Z0-9._-]+\.[^\s)"\]]+/);
  return match ? match[0] : null;
}

export function addMessage(taskId: string, role: string, content: string, cost?: number, username?: string): Message {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO messages (id, task_id, role, content, cost, username, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, role, content, cost ?? null, username ?? null, now);

  // Extract verification URL from assistant messages and store on the task
  if (role === 'assistant') {
    const url = extractVerificationUrl(content);
    if (url) {
      db.prepare('UPDATE tasks SET verification_url = ? WHERE id = ?').run(url, taskId);
    }
  }

  // Return constructed message without a read-back query
  return { id, task_id: taskId, role, content, cost: cost ?? null, created_at: now };
}

export function addTokenUsage(taskId: string, inputTokens: number, outputTokens: number): void {
  const db = getDb();
  db.prepare(
    'UPDATE tasks SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ? WHERE id = ?'
  ).run(inputTokens, outputTokens, taskId);
  invalidateTokenTotalsCache();
}

export function getMessages(taskId: string, limit?: number, offset?: number): Message[] {
  const db = getDb();
  if (limit) {
    return db
      .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?')
      .all(taskId, limit, offset || 0) as Message[];
  }
  return db
    .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as Message[];
}

export function getMessageCount(taskId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM messages WHERE task_id = ?').get(taskId) as { count: number };
  return row.count;
}

/**
 * Delete assistant messages from the current session (after the last user message).
 * Used when re-processing output from scratch (e.g., on reconnect) to avoid duplicates.
 */
export function deleteCurrentSessionAssistantMessages(taskId: string): void {
  const db = getDb();
  const messages = getMessages(taskId);
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    db.prepare(
      "DELETE FROM messages WHERE task_id = ? AND role = 'assistant' AND created_at > ?"
    ).run(taskId, lastUserMsg.created_at);
  } else {
    db.prepare(
      "DELETE FROM messages WHERE task_id = ? AND role = 'assistant'"
    ).run(taskId);
  }
}

/**
 * Update the cost field on an existing message (used to attach cost from result event).
 */
export function updateMessageCost(messageId: string, cost: number): void {
  const db = getDb();
  db.prepare('UPDATE messages SET cost = ? WHERE id = ?').run(cost, messageId);
  invalidateTokenTotalsCache();
}
