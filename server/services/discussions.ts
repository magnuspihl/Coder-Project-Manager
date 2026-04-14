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
  participant_id: string | null;
  created_at: string;
}

export interface DiscussionParticipant {
  id: string;
  discussion_id: string;
  workspace_id: string;
  workspace_name: string;
  claude_session_id: string | null;
  project_dir: string | null;
  status: string;
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
  username?: string,
  participantId?: string
): DiscussionMessage {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO discussion_messages (id, discussion_id, role, content, cost, username, participant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, discussionId, role, content, cost ?? null, username ?? null, participantId ?? null, now);
  return { id, discussion_id: discussionId, role, content, cost: cost ?? null, username: username ?? null, participant_id: participantId ?? null, created_at: now };
}

export function getDiscussionMessages(discussionId: string, limit?: number, beforeId?: string): DiscussionMessage[] {
  const db = getDb();
  if (limit && beforeId) {
    // Fetch older messages before a given ID
    const ref = db.prepare('SELECT created_at FROM discussion_messages WHERE id = ?').get(beforeId) as { created_at: string } | undefined;
    if (!ref) return [];
    return db.prepare(
      'SELECT * FROM discussion_messages WHERE discussion_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(discussionId, ref.created_at, ref.created_at, beforeId, limit).reverse() as DiscussionMessage[];
  }
  if (limit) {
    // Fetch the latest N messages
    return db.prepare(
      'SELECT * FROM (SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) sub ORDER BY created_at ASC, id ASC'
    ).all(discussionId, limit) as DiscussionMessage[];
  }
  return db.prepare(
    'SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC'
  ).all(discussionId) as DiscussionMessage[];
}

export function getDiscussionMessageCount(discussionId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM discussion_messages WHERE discussion_id = ?').get(discussionId) as { cnt: number };
  return row.cnt;
}

export function getDiscussionMessagesAfterId(discussionId: string, afterId: string): DiscussionMessage[] {
  const db = getDb();
  const ref = db.prepare('SELECT created_at FROM discussion_messages WHERE id = ?').get(afterId) as { created_at: string } | undefined;
  if (!ref) return [];
  return db.prepare(
    'SELECT * FROM discussion_messages WHERE discussion_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC'
  ).all(discussionId, ref.created_at, ref.created_at, afterId) as DiscussionMessage[];
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

// Participant management

export function addParticipant(discussionId: string, workspaceId: string, workspaceName: string): DiscussionParticipant {
  const db = getDb();
  const id = uuid();
  const claudeSessionId = uuid();
  db.prepare(
    'INSERT INTO discussion_participants (id, discussion_id, workspace_id, workspace_name, claude_session_id, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, discussionId, workspaceId, workspaceName, claudeSessionId, 'active');
  return db.prepare('SELECT * FROM discussion_participants WHERE id = ?').get(id) as DiscussionParticipant;
}

export function removeParticipant(participantId: string): void {
  const db = getDb();
  db.prepare("UPDATE discussion_participants SET status = 'removed' WHERE id = ?").run(participantId);
}

export function getParticipants(discussionId: string): DiscussionParticipant[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM discussion_participants WHERE discussion_id = ? AND status = 'active' ORDER BY created_at ASC"
  ).all(discussionId) as DiscussionParticipant[];
}

export function getParticipant(participantId: string): DiscussionParticipant | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM discussion_participants WHERE id = ?').get(participantId) as DiscussionParticipant | undefined;
}

export function updateParticipantProjectDir(participantId: string, projectDir: string): void {
  const db = getDb();
  db.prepare('UPDATE discussion_participants SET project_dir = ? WHERE id = ?').run(projectDir, participantId);
}

/**
 * Build catch-up context for an agent that has been idle.
 * participantId: the participant's ID, or '__host__' for the host agent.
 * Returns formatted text of all messages since the agent's last response.
 */
export function buildCatchUpContext(discussionId: string, participantId: string): string {
  const db = getDb();
  // Find the last assistant message from this agent
  const isHost = participantId === '__host__';
  const lastMsg = isHost
    ? db.prepare(
        "SELECT created_at FROM discussion_messages WHERE discussion_id = ? AND participant_id IS NULL AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"
      ).get(discussionId) as { created_at: string } | undefined
    : db.prepare(
        "SELECT created_at FROM discussion_messages WHERE discussion_id = ? AND participant_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"
      ).get(discussionId, participantId) as { created_at: string } | undefined;

  // Determine the earliest point to include messages from.
  // For participants: never earlier than when they were invited (created_at).
  // For the host: no floor needed (host was always part of the discussion).
  let floor: string | null = null;
  if (!isHost) {
    const participant = db.prepare(
      "SELECT created_at FROM discussion_participants WHERE id = ?"
    ).get(participantId) as { created_at: string } | undefined;
    floor = participant?.created_at || null;
  }

  let messages: DiscussionMessage[];
  if (lastMsg) {
    // Use whichever is later: last message or invite time
    const since = floor && floor > lastMsg.created_at ? floor : lastMsg.created_at;
    messages = db.prepare(
      "SELECT * FROM discussion_messages WHERE discussion_id = ? AND created_at > ? ORDER BY created_at ASC"
    ).all(discussionId, since) as DiscussionMessage[];
  } else if (floor) {
    // Participant has never spoken — only get messages since they were invited
    messages = db.prepare(
      "SELECT * FROM discussion_messages WHERE discussion_id = ? AND created_at >= ? ORDER BY created_at ASC"
    ).all(discussionId, floor) as DiscussionMessage[];
  } else {
    // Host has never spoken and no floor — get all messages
    messages = db.prepare(
      "SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC"
    ).all(discussionId) as DiscussionMessage[];
  }

  // Exclude the latest user message directed at this agent (it's already in the -p prompt)
  // and exclude this agent's own messages (it already has those in its session)
  const selfId = isHost ? null : participantId;
  messages = messages.filter(msg => {
    // Skip this agent's own assistant messages (it has them in its session already)
    if (msg.role === 'assistant') {
      if (isHost && !msg.participant_id) return false;
      if (!isHost && msg.participant_id === selfId) return false;
    }
    return true;
  });

  // Drop the very last message if it's the user message directed at this agent
  // (that message is being sent as the -p prompt)
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      if (isHost && !last.participant_id) messages.pop();
      else if (!isHost && last.participant_id === selfId) messages.pop();
    }
  }

  if (messages.length === 0) return '';

  // Look up the discussion to identify the host workspace
  const disc = db.prepare('SELECT workspace_name FROM discussions WHERE id = ?').get(discussionId) as { workspace_name: string } | undefined;
  const hostName = disc?.workspace_name || 'Host';

  const lines: string[] = [
    '[CONVERSATION CONTEXT: This is a multi-agent discussion. The following messages happened while you were idle. Other participants are real AI agents on different workspaces.]'
  ];
  for (const msg of messages) {
    let label: string;
    if (msg.role === 'user') {
      label = msg.username || 'User';
    } else if (msg.role === 'system') {
      label = 'System';
    } else {
      // Assistant — use workspace name to distinguish agents
      label = msg.username || hostName;
    }
    // Strip mention tags from context messages
    const cleanContent = msg.content.replace(/\[MENTION:[^\]]+\]/g, '').trim();
    lines.push(`[${label}]: ${cleanContent}`);
  }
  // List all agents in the discussion so the agent knows who it can mention
  const allParticipants = db.prepare(
    "SELECT workspace_name FROM discussion_participants WHERE discussion_id = ? AND status = 'active'"
  ).all(discussionId) as Array<{ workspace_name: string }>;
  const agentNames = [hostName, ...allParticipants.map(p => p.workspace_name)];

  lines.push('[END CONTEXT]');
  lines.push(`Agents in this discussion: ${agentNames.join(', ')}. To direct a message to another agent, include [MENTION:workspace_name] at the end of your response (e.g. [MENTION:${agentNames[0]}]). The mentioned agent will receive the conversation and can respond.`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Build a short instruction telling an agent about other participants and the mention system.
 * Used when there's no catch-up context but participants exist.
 */
export function buildMentionInstruction(discussionId: string): string {
  const db = getDb();
  const disc = db.prepare('SELECT workspace_name FROM discussions WHERE id = ?').get(discussionId) as { workspace_name: string } | undefined;
  const hostName = disc?.workspace_name || 'Host';
  const participants = db.prepare(
    "SELECT workspace_name FROM discussion_participants WHERE discussion_id = ? AND status = 'active'"
  ).all(discussionId) as Array<{ workspace_name: string }>;
  if (participants.length === 0) return '';

  const agentNames = [hostName, ...participants.map(p => p.workspace_name)];
  return `[Multi-agent discussion. Agents: ${agentNames.join(', ')}. To direct a message to another agent, include [MENTION:workspace_name] at the end of your response. The mentioned agent will receive the conversation and can respond.]`;
}

/**
 * Get the latest non-user discussion message timestamp per workspace.
 * Only considers active discussions. Returns a map of workspace_id → ISO timestamp.
 */
export function getLatestDiscussionMessageByWorkspace(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT d.workspace_id, MAX(dm.created_at) as latest_at
     FROM discussion_messages dm
     JOIN discussions d ON dm.discussion_id = d.id
     WHERE d.status = 'active' AND dm.role != 'user'
     GROUP BY d.workspace_id`
  ).all() as Array<{ workspace_id: string; latest_at: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.workspace_id] = row.latest_at;
  }
  return result;
}
