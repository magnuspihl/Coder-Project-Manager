-- Users table: caches Coder user info for display purposes
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled task',
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'working', 'awaiting_feedback', 'completed', 'failed', 'cancelled')),
  position INTEGER NOT NULL,
  project_dir TEXT,
  claude_session_id TEXT,
  failed_reason TEXT,
  verification_url TEXT,
  branch TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_position ON tasks(workspace_id, position);

-- Messages table: conversation history per task
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  cost REAL,
  username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);

-- Stream log table: persisted Claude output log per task
CREATE TABLE IF NOT EXISTS stream_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stream_log_task ON stream_log(task_id, id);

-- Discussions table: persistent per-workspace chat sessions
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  project_dir TEXT,
  full_access INTEGER NOT NULL DEFAULT 0,
  ssh_pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_discussions_workspace ON discussions(workspace_id, status);

-- Discussion messages table: conversation history per discussion
CREATE TABLE IF NOT EXISTS discussion_messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  cost REAL,
  username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discussion_messages ON discussion_messages(discussion_id, created_at);

-- Task requests: proposed tasks from discussion sessions
CREATE TABLE IF NOT EXISTS task_requests (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'dismissed')),
  created_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_task_requests_discussion ON task_requests(discussion_id, status);

-- Discussion participants: additional workspace agents in a discussion
CREATE TABLE IF NOT EXISTS discussion_participants (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  claude_session_id TEXT,
  project_dir TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_disc_participants ON discussion_participants(discussion_id, status);

-- Workspace settings: persistent per-workspace configuration
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY,
  discussion_full_access INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions table: server-side session storage
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  coder_access_token TEXT NOT NULL,
  coder_refresh_token TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_task_cost ON messages(task_id, cost) WHERE cost IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_deleted ON tasks(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
