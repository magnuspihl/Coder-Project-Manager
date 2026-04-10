import { getDb } from '../db/index.js';
import { v4 as uuid } from 'uuid';

export interface Discussion {
  id: string;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  claude_session_id: string | null;
  status: string;
  project_dir: string | null;
  full_access: number;
  ssh_pid: number | null;
  created_at: string;
  updated_at: string;
}

export interface DiscussionMessage {
  id: string;
  discussion_id: string;
  role: string;
  content: string;
  cost: number | null;
  username: string | null;
  created_at: string;
}

export interface TaskRequest {
  id: string;
  discussion_id: string;
  prompt: string;
  branch: string | null;
  status: string;
  created_task_id: string | null;
  created_at: string;
}

/**
 * Get the active discussion for a workspace, or null if none exists.
 */
export function getActiveDiscussion(workspaceId: string): Discussion | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM discussions WHERE workspace_id = ? AND status = 'active' LIMIT 1"
  ).get(workspaceId) as Discussion | undefined;
}

export function getDiscussion(id: string): Discussion | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM discussions WHERE id = ?').get(id) as Discussion | undefined;
}

export function createDiscussion(params: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  fullAccess?: boolean;
}): Discussion {
  const db = getDb();
  const id = uuid();
  const claudeSessionId = uuid();
  const fullAccess = params.fullAccess ? 1 : 0;

  db.prepare(
    `INSERT INTO discussions (id, workspace_id, workspace_name, user_id, claude_session_id, full_access, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`
  ).run(id, params.workspaceId, params.workspaceName, params.userId, claudeSessionId, fullAccess);

  return getDiscussion(id)!;
}

// Workspace settings

export function getDiscussionFullAccess(workspaceId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT discussion_full_access FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { discussion_full_access: number } | undefined;
  return row?.discussion_full_access === 1;
}

export function setDiscussionFullAccess(workspaceId: string, fullAccess: boolean): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, discussion_full_access, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET discussion_full_access = ?, updated_at = ?`
  ).run(workspaceId, fullAccess ? 1 : 0, new Date().toISOString(), fullAccess ? 1 : 0, new Date().toISOString());
}

export function closeDiscussion(id: string): void {
  const db = getDb();
  db.prepare("UPDATE discussions SET status = 'closed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function updateDiscussionFullAccess(id: string, fullAccess: boolean): void {
  const db = getDb();
  db.prepare("UPDATE discussions SET full_access = ?, updated_at = ? WHERE id = ?")
    .run(fullAccess ? 1 : 0, new Date().toISOString(), id);
}

export function updateDiscussionSessionId(id: string, claudeSessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE discussions SET claude_session_id = ?, updated_at = ? WHERE id = ?")
    .run(claudeSessionId, new Date().toISOString(), id);
}

export function addDiscussionMessage(
  discussionId: string,
  role: string,
  content: string,
  cost?: number,
  username?: string
): DiscussionMessage {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO discussion_messages (id, discussion_id, role, content, cost, username, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, discussionId, role, content, cost ?? null, username ?? null, now);
  return { id, discussion_id: discussionId, role, content, cost: cost ?? null, username: username ?? null, created_at: now };
}

export function getDiscussionMessages(discussionId: string): DiscussionMessage[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC'
  ).all(discussionId) as DiscussionMessage[];
}

/**
 * Delete assistant messages from the current discussion session (after the last user message).
 * Used on reconnect to avoid duplicates when re-processing output.
 */
export function deleteCurrentDiscussionAssistantMessages(discussionId: string): void {
  const db = getDb();
  const messages = getDiscussionMessages(discussionId);
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    db.prepare(
      "DELETE FROM discussion_messages WHERE discussion_id = ? AND role = 'assistant' AND created_at > ?"
    ).run(discussionId, lastUserMsg.created_at);
  } else {
    db.prepare(
      "DELETE FROM discussion_messages WHERE discussion_id = ? AND role = 'assistant'"
    ).run(discussionId);
  }
}

// Task request management

export function createTaskRequest(discussionId: string, prompt: string, branch?: string): TaskRequest {
  const db = getDb();
  const id = uuid();
  db.prepare(
    'INSERT INTO task_requests (id, discussion_id, prompt, branch, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, discussionId, prompt, branch || null, 'pending');
  return db.prepare('SELECT * FROM task_requests WHERE id = ?').get(id) as TaskRequest;
}

export function getTaskRequests(discussionId: string): TaskRequest[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM task_requests WHERE discussion_id = ? ORDER BY created_at ASC'
  ).all(discussionId) as TaskRequest[];
}

export function getPendingTaskRequests(discussionId: string): TaskRequest[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM task_requests WHERE discussion_id = ? AND status = 'pending' ORDER BY created_at ASC"
  ).all(discussionId) as TaskRequest[];
}

export function getTaskRequest(id: string): TaskRequest | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM task_requests WHERE id = ?').get(id) as TaskRequest | undefined;
}

export function approveTaskRequest(id: string, createdTaskId: string): void {
  const db = getDb();
  db.prepare("UPDATE task_requests SET status = 'created', created_task_id = ? WHERE id = ?")
    .run(createdTaskId, id);
}

export function dismissTaskRequest(id: string): void {
  const db = getDb();
  db.prepare("UPDATE task_requests SET status = 'dismissed' WHERE id = ?").run(id);
}
